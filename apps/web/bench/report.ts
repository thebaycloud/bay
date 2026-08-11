/**
 * What the harness measured, as a table a person can argue with.
 *
 *   npm run bench:report -- --batch aug09                 # from the database
 *   npm run bench:report -- --file bench/results/x.jsonl  # from the raw run
 *   npm run bench:report -- --batch aug09 --md > report.md
 *
 * Two sources because the raw JSONL exists the moment a batch finishes and the
 * database copy needs cloud-sql-proxy. The file view answers "how did this run
 * go"; only the database view can answer "how did it go compared with last
 * time", or say where the time went, or what the agents cost — those live in
 * `deploy_stages` and `deploy_agent_runs` and are joined here by run_id.
 *
 * Three rules the numbers below follow, all of them about not flattering
 * ourselves:
 *
 *  1. `platform` rows are excluded from every rate. A quota error says nothing
 *     about whether we can deploy a repository.
 *  2. Projects with no expectation on file are reported but not scored. The
 *     first batch is a baseline, not an exam we grade ourselves on.
 *  3. The headline duration is time-to-ANSWERING, not time-to-declared-live.
 *     The gap between them is a real wait a real person sits through.
 */
import { readFileSync, existsSync } from "node:fs";

interface Row {
  batch: string; target: string; project: string; mode: string; rep: number;
  concurrency?: number;
  runId: string | null; slug: string | null; url: string | null;
  reservedMs: number | null; activatedMs: number | null; firstOkMs: number | null;
  outcome: string; verdict: string | null; reason: string | null; error: string | null;
  serverStatus?: string | null; serverStage?: string | null; serverError?: string | null;
  serverLog?: string | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const wantMd = process.argv.includes("--md");

/** Nearest-rank percentile: every number it prints is a deploy that happened. */
function pct(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  return clean[Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1))];
}

const secs = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n / 1000).toFixed(1)}s`);

async function fromFile(file: string): Promise<Row[]> {
  if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(2); }
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

async function fromDb(batch: string): Promise<Row[]> {
  const { getPool } = await import("@/lib/db");
  const { rows } = await getPool("supersonic_platform").query(
    `SELECT batch, target, project, mode, rep, concurrency, run_id AS "runId", slug, url,
            reserved_ms AS "reservedMs", activated_ms AS "activatedMs", first_ok_ms AS "firstOkMs",
            outcome, verdict, reason, error,
            server_status AS "serverStatus", server_stage AS "serverStage", server_error AS "serverError",
            server_log AS "serverLog"
       FROM bench_runs WHERE batch = $1 ORDER BY project, mode, rep`,
    [batch],
  );
  return rows as Row[];
}

/**
 * Where the time went inside the deploys of this batch, from the stages the
 * pipeline recorded itself.
 *
 * Joined on run_id rather than recomputed: `deploy_stages` is the only thing
 * that knows what a stage boundary means, and a second opinion about it here
 * would be a second thing to keep correct.
 */
async function stageBreakdown(runIds: string[]): Promise<Array<{ stage: string; n: number; p50: number }>> {
  if (!runIds.length) return [];
  const { getPool } = await import("@/lib/db");
  const { rows } = await getPool("supersonic_platform").query(
    `SELECT stage, count(*)::int AS n,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM ended_at - started_at)))::numeric, 1)::float AS p50
       FROM deploy_stages
      WHERE run_id = ANY($1) AND ended_at IS NOT NULL
      GROUP BY stage ORDER BY p50 DESC`,
    [runIds],
  );
  return rows as Array<{ stage: string; n: number; p50: number }>;
}

/** What the LLMs cost across this batch, split by which one was called. */
async function agentCost(runIds: string[]): Promise<Array<{ role: string; runs: number; tokens: number; p50_ms: number | null }>> {
  if (!runIds.length) return [];
  const { getPool } = await import("@/lib/db");
  const { rows } = await getPool("supersonic_platform").query(
    `SELECT role, count(*)::int AS runs,
            sum(tokens_in + tokens_out + tokens_reasoning)::bigint AS tokens,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float AS p50_ms
       FROM deploy_agent_runs WHERE run_id = ANY($1) GROUP BY role ORDER BY tokens DESC`,
    [runIds],
  );
  return rows as Array<{ role: string; runs: number; tokens: number; p50_ms: number | null }>;
}

function summarise(rows: Row[]) {
  const byProject = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byProject.get(r.project);
    if (list) list.push(r); else byProject.set(r.project, [r]);
  }
  return byProject;
}

async function main() {
  const file = arg("file");
  const batch = arg("batch");
  if (!file && !batch) { console.error("pass --batch <name> or --file <results.jsonl>"); process.exit(2); }
  const rows = file ? await fromFile(file) : await fromDb(batch!);
  if (!rows.length) { console.log("no rows"); return; }

  const out: string[] = [];
  const say = (s = "") => out.push(s);

  const targets = [...new Set(rows.map((r) => r.target))].join(" + ");
  say(`# bench ${rows[0].batch} · ${targets}`);
  say();

  // Said once, at the top, before any number below it is read. A batch run in
  // parallel lanes is a correctness result with timings attached, not a timing
  // result: its deploys were queueing behind one shared build pool and each
  // other. The durations are still printed — they are the truth about what this
  // batch did — but nobody should carry them into a comparison with a batch that
  // ran alone.
  const contended = rows.filter((r) => (r.concurrency ?? 1) > 1);
  if (contended.length) {
    const n = Math.max(...contended.map((r) => r.concurrency ?? 1));
    say(`> Run with up to **${n} deploys at a time**. The pass/fail column means what it says;`);
    say(`> the durations do not compare with a \`--concurrency 1\` batch, because these deploys`);
    say(`> were queued behind one another and a shared build pool.`);
    say();
  }

  // Scored, unscored and excused, kept apart. Collapsing them into one
  // percentage is the single easiest way to make this whole exercise lie.
  const scored = rows.filter((r) => r.verdict === "pass" || r.verdict === "fail");
  const platform = rows.filter((r) => r.verdict === "platform");
  const inconclusive = rows.filter((r) => r.verdict === "inconclusive");
  const unscored = rows.filter((r) => r.verdict === null);
  const passed = scored.filter((r) => r.verdict === "pass").length;

  say(`- **${passed}/${scored.length}** scored deploys met their expectation`
    + (scored.length ? ` (${Math.round((passed / scored.length) * 100)}%)` : ""));
  if (unscored.length) say(`- ${unscored.length} deploys had no expectation on file — reported below, not scored`);
  if (platform.length) say(`- ${platform.length} excluded: the platform got in the way, not the deploy engine`);
  // Counted apart and named plainly, because this is the harness's own fault and
  // burying it in the failure rate would be the most flattering possible lie:
  // it would make a budget we guessed too low look like a product that does not
  // deploy. Every one of these is a `budgetS` that wants raising.
  if (inconclusive.length) {
    say(`- ${inconclusive.length} inconclusive: the harness stopped watching while the server was still building`);
  }
  say();

  say(`| project | mode | outcome | live | answering | lag | link |`);
  say(`|---|---|---|---|---|---|---|`);
  for (const [project, list] of summarise(rows)) {
    for (const mode of ["cold", "warm"]) {
      const cells = list.filter((r) => r.mode === mode);
      if (!cells.length) continue;
      const live = pct(cells.map((c) => c.activatedMs!).filter((n) => n != null), 50);
      const ok = pct(cells.map((c) => c.firstOkMs!).filter((n) => n != null), 50);
      // The wait after we already ticked the box.
      const lag = live !== null && ok !== null ? ok - live : null;
      const verdicts = [...new Set(cells.map((c) => c.verdict ?? c.outcome))].join("/");
      const url = cells.find((c) => c.url)?.url ?? "";
      say(`| ${project} | ${mode} | ${verdicts} | ${secs(live)} | ${secs(ok)} | ${secs(lag)} | ${url ? `[link](${url})` : "—"} |`);
    }
  }
  say();

  const failures = rows.filter((r) => r.verdict === "fail" || (r.verdict === null && r.outcome !== "live"));
  if (failures.length) {
    say(`## What went wrong`);
    say();
    for (const f of failures) {
      // The stage first. "Where did it break" is what decides what to do next,
      // and it is the thing that used to require an hour with `deploy-status`
      // and a token before anyone could even start.
      const where = f.serverStage ? ` at **${f.serverStage.replace(/\s+/g, " ").slice(0, 90)}**` : "";
      const why = (f.serverError ?? f.error ?? f.reason ?? "no reason recorded").replace(/\s+/g, " ").slice(0, 300);
      say(`- **${f.project}** (${f.mode} #${f.rep}) — ${f.outcome}${where}: ${why}`);
      // The first error line, indented under it. The line above is what the
      // deploy CONCLUDED; this is what actually happened, and they are routinely
      // three layers apart — "Deployment cannot be repaired in the repository"
      // sitting on top of "Environment variable not found: DATABASE_URL".
      const cause = f.serverLog?.split("\n").find((l) => l.trim());
      if (cause && !why.includes(cause.slice(0, 40))) say(`  - caused by: \`${cause.slice(0, 240)}\``);
    }
    say();

    // Where deploys break, counted. One project failing at `agent` is a bad
    // repo; four projects failing at `agent` is a bug in the agent, and the two
    // read identically in a list of individual failures.
    const byStage = new Map<string, number>();
    for (const f of failures) {
      // The stage NAME, not the whole field. The control plane packs the failing
      // message into `stage` — "agent · `ERROR: gcloud crashed (FileNotFound…`" —
      // so grouping on the raw value groups by error text and every row lands in
      // a bucket of one, which is precisely the count that cannot tell a bad repo
      // from a broken stage.
      const s = f.serverStage?.split("·")[0].trim() || (f.serverStage ? f.serverStage.slice(0, 40) : "the server was never asked");
      byStage.set(s, (byStage.get(s) ?? 0) + 1);
    }
    if (byStage.size) {
      say(`### Where it broke`);
      say();
      for (const [stage, n] of [...byStage].sort((a, b) => b[1] - a[1])) say(`- ${n}× ${stage}`);
      say();
    }
  }

  // The harness's own misses, kept visible rather than quietly dropped. Each one
  // is a `budgetS` in corpus.json that is lower than the deploy it is timing.
  if (inconclusive.length) {
    say(`## Inconclusive — the harness gave up first`);
    say();
    for (const r of inconclusive) {
      say(`- **${r.project}** (${r.mode} #${r.rep}) — still at ${r.serverStage ?? "an unknown stage"} when the budget ran out; raise \`budgetS\``);
    }
    say();
  }

  // The comparison this harness exists for. Present only when one batch holds
  // both, which is the only way it is an apples-to-apples subtraction.
  //
  // Restricted to uncontended rows, and silent rather than approximate when
  // there are none. This subtraction is the one number the harness was built to
  // produce, and a version of it computed from deploys that were queueing behind
  // each other would not be a worse estimate of the handoff cost — it would be
  // an estimate of something else, printed under the handoff's name.
  const alone = rows.filter((r) => (r.concurrency ?? 1) === 1);
  const local = alone.filter((r) => r.target === "local" && r.firstOkMs != null);
  const prod = alone.filter((r) => r.target === "prod" && r.firstOkMs != null);
  if (local.length && prod.length) {
    const lp = pct(local.map((r) => r.firstOkMs!), 50)!;
    const pp = pct(prod.map((r) => r.firstOkMs!), 50)!;
    say(`## What production costs over running it here`);
    say();
    say(`local p50 ${secs(lp)} · prod p50 ${secs(pp)} · **difference ${secs(pp - lp)}**`);
    say();
    say(`Prod hands the deploy to a Cloud Run job and local runs it in the request, so`);
    say(`this difference is the handoff, the job's cold start and the image pull — the`);
    say(`lump \`app/api/deploy/route.ts\` describes as unmeasured.`);
    say();
  }

  if (!file) {
    const runIds = rows.map((r) => r.runId).filter((v): v is string => !!v);
    const stages = await stageBreakdown(runIds);
    if (stages.length) {
      say(`## Where the time went (from deploy_stages)`);
      say();
      say(`| stage | n | p50 |`);
      say(`|---|---|---|`);
      for (const s of stages) say(`| ${s.stage} | ${s.n} | ${s.p50}s |`);
      say();
    }
    const cost = await agentCost(runIds);
    if (cost.length) {
      say(`## What the agents cost`);
      say();
      say(`| role | runs | tokens | p50 duration |`);
      say(`|---|---|---|---|`);
      for (const c of cost) say(`| ${c.role} | ${c.runs} | ${Number(c.tokens).toLocaleString("en-US")} | ${secs(c.p50_ms)} |`);
      say();
    } else {
      say(`_No agent runs recorded for this batch — either nothing needed repairing and`);
      say(`every plan was cached, or nothing is writing \`deploy_agent_runs\` yet._`);
      say();
    }
  }

  console.log(out.join("\n"));
  if (!wantMd && !file) console.error("\n(rendered as markdown — pipe to a file with --md > report.md)");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
