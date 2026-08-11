/**
 * The deploy harness: ten real projects, through the door a user walks through.
 *
 *   npm run bench -- --batch aug09                              # the gate: ~10 min
 *   npm run bench -- --batch aug09 --concurrency 1 --modes cold,warm --reps 3
 *
 * Two runs, not one, and the flags are the whole difference between them.
 *
 * The first is a GATE. Ten projects, cold, once each, five deploys at a time —
 * it answers "does the engine still deploy these ten things" in about ten
 * minutes, which is short enough to run on a change. Its durations are recorded
 * but contended: five deploys queueing behind one Cloud Build pool time each
 * other, not themselves.
 *
 * The second is a MEASUREMENT. One deploy at a time, both modes, three reps —
 * hours, and the only run whose numbers mean anything on their own. At the ~231s
 * a production deploy actually takes, there is no arrangement in which this is
 * quick, so it is not the default and does not pretend to be.
 *
 * `Cell.concurrency` is written onto every row so the two can never be averaged
 * together by accident.
 *
 * It drives the actual CLI. Not `runDeploy`, not an insert into `deploy_runs` —
 * the binary, over HTTP, with a token. Everything interesting about a deploy
 * that is not the pipeline lives in the parts an internal call skips: the auth,
 * the plan gate, the slug reservation, the upload, the handoff to the job and
 * that job's cold start. The 227-second gap described in
 * `app/api/deploy/route.ts` happened entirely inside them.
 *
 * `--target local` points the same CLI at a control plane running on this
 * laptop. The pipeline is identical; what differs is that prod hands the deploy
 * to a Cloud Run job (`DEPLOY_JOB=1`) and local runs it inline. So the two
 * measurements subtract: prod minus local is what the handoff costs, which is
 * the number that has never existed.
 *
 * Results are written to JSONL as they happen, and imported into `bench_runs`
 * at the end (or later, with `--import`). Two stores rather than one because a
 * full batch is over an hour of real builds, and losing it to a database blip at
 * minute ninety would be its own kind of measurement error.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastJsonObject, reserveLine } from "./parse";
import { Status } from "./status";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const CLI = join(repoRoot, "packages", "cli", "index.js");

/* -------------------------------------------------------------------------- */
/* Corpus                                                                     */
/* -------------------------------------------------------------------------- */

interface Expect { outcome: "live" | "refused" | "failed" | "unknown"; path?: string; status?: number; body?: string }
interface Project {
  key: string;
  repo: string | null;
  folder?: string;
  upstream: string;
  sha: string;
  why: string;
  expectLane: string | null;
  expect: Expect;
  budgetS: number;
}

function corpus(): Project[] {
  const raw = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8"));
  return raw.projects as Project[];
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

interface Args {
  target: "local" | "prod";
  batch: string;
  only: string[] | null;
  modes: Array<"cold" | "warm">;
  reps: number;
  concurrency: number;
  keep: boolean;
  dryRun: boolean;
  importOnly: string | null;
  url: string;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const target = (flag("target") ?? "prod") as "local" | "prod";
  if (target !== "local" && target !== "prod") throw new Error(`--target must be local or prod, got ${target}`);
  return {
    target,
    // The batch name is what keeps two runs a week apart from being averaged
    // together. Required rather than defaulted to a timestamp, because a name
    // somebody chose ("before-planner-off") is the only thing that makes a row
    // findable six weeks later.
    batch: flag("batch") ?? die("--batch <name> is required — it is how these rows are found again"),
    only: flag("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    // Cold and one rep by DEFAULT, because the default has to be the run people
    // will actually do. `cold,warm × 3` is six times the deploys, and at the ~231s
    // a real production deploy takes (measured, `supersonic-deploy-job-j4s9w`)
    // that is the difference between a gate somebody runs on a change and a
    // six-hour batch nobody runs twice. Warm and reps are still here, one flag
    // away, for the run that is actually asking a question about variance.
    modes: (flag("modes") ?? "cold").split(",").map((s) => s.trim()) as Array<"cold" | "warm">,
    reps: Number(flag("reps") ?? 1),
    concurrency: Math.max(1, Number(flag("concurrency") ?? 5)),
    keep: has("keep"),
    dryRun: has("dry-run"),
    importOnly: flag("import") ?? null,
    url: flag("url") ?? (target === "local" ? "http://localhost:3000" : "https://app.supersonic.cv"),
  };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* One deploy                                                                 */
/* -------------------------------------------------------------------------- */

interface Cell {
  batch: string;
  target: "local" | "prod";
  project: string;
  repoUrl: string;
  repoSha: string;
  mode: "cold" | "warm";
  rep: number;
  /**
   * How many deploys this harness had in flight while this one ran.
   *
   * Recorded on the row rather than on the batch because it is the one fact that
   * decides whether a duration here may be compared with a duration there. At
   * anything above 1 these deploys are queueing behind the same Cloud Build pool
   * and each other's cold starts, so the timings are a measurement of the batch,
   * not of the deploy. Without this column a fast parallel batch and a slow
   * sequential one average together into a number that describes neither.
   */
  concurrency: number;
  runId: string | null;
  slug: string | null;
  url: string | null;
  startedAt: string;
  reservedMs: number | null;
  activatedMs: number | null;
  firstOkMs: number | null;
  finishedAt: string | null;
  outcome: "live" | "failed" | "timeout" | "refused";
  verdict: "pass" | "fail" | "platform" | "inconclusive" | null;
  reason: string | null;
  error: string | null;

  /**
   * What the SERVER says happened, asked after the CLI is done with.
   *
   * The single most useful thing this harness records, and it was missing on the
   * day it was written. The CLI reports what the CLI could see: a stream that
   * ended, an exit code, at best a forwarded message. The server knows which
   * stage it was in and why it stopped. Every finding of 10 Aug — the symlink
   * crash in `gcloud builds submit`, a deploy still building while the harness
   * called it failed — came from `/api/apps/<slug>/deploy-status` being asked BY
   * HAND after the fact, because the row said `failed` and nothing else. A red
   * row that cannot say where it went red costs an hour of somebody's afternoon
   * each time, which is the difference between a tripwire and an instrument.
   *
   * Null when there is no slug to ask about, or the ask failed. Never a guess.
   */
  serverStatus: string | null;
  serverStage: string | null;
  serverError: string | null;

  /**
   * The error lines from the deploy's own log — the root cause, in its words.
   *
   * `serverStage` says WHERE it broke and is the last thing said, which for a
   * failed deploy is the repair agent's closing summary rather than the thing
   * that actually went wrong. On 10 Aug `epic-stack` recorded
   * `agent · Deployment cannot be repaired in the repository.` — true, useless,
   * and three layers above the fact that the build died on
   * `Environment variable not found: DATABASE_URL` because SQLite provisioning
   * is not wired up. That sentence was thirty lines up the log and nowhere else.
   *
   * Fetched over HTTP for the same reason as `serverStage`: it needs only the
   * token, where the equivalent (`deploy_failures`, joined by run_id) needs a
   * database AND a run id the CLI does not always manage to report.
   */
  serverLog: string | null;
}

/**
 * Run the CLI once and time it from the outside.
 *
 * The segments come from the CLI's own output as it appears, which is why this
 * reads the stream rather than waiting for the exit code: the reserve line is
 * printed the moment the slug is handed out, long before the build ends, and it
 * is the only place the URL-first promise ("a live link in ~0.1s") can actually
 * be checked.
 */
function ship(p: Project, opts: { url: string; token: string; budgetMs: number; onLine: (l: string) => void }): Promise<{
  json: Record<string, unknown> | null; reservedMs: number | null; code: number | null; timedOut: boolean; t0: number;
  /** The slug and address as the CLI announced them, before any of this could go wrong. */
  slug: string | null;
  reservedUrl: string | null;
  /** The last of what the CLI said. The only account of a run that produced no JSON. */
  tail: string;
}> {
  const args = p.repo
    ? ["ship", "--repo", p.repo, "--wait", "--json"]
    : ["ship", "--wait", "--json"];
  const cwd = p.repo ? repoRoot : join(repoRoot, p.folder!);
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, SUPERSONIC_URL: opts.url, SUPERSONIC_TOKEN: opts.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Two buffers, because the CLI has two streams and means different things by
    // them: `print` puts DATA on stdout, `info`/`die` put narration and errors on
    // stderr (packages/cli/index.js:45-51). Merged into one buffer they are
    // unparseable — the pipes are independent, so nothing orders a stderr chunk
    // against a stdout one, and on a failed deploy the `✗ …` line lands in the
    // MIDDLE of the pretty-printed JSON block. That is not hypothetical: it cost
    // the runId of every failed row in the first good batch of 10 Aug, which is
    // the join to `deploy_stages` for exactly the deploys worth investigating.
    let out = "";
    let err = "";
    let reservedMs: number | null = null;
    let slug: string | null = null;
    let reservedUrl: string | null = null;
    let settled = false;
    const finish = (r: { json: Record<string, unknown> | null; code: number | null; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      // stdout only. Everything the CLI intends as a result is printed there.
      const json = r.json ?? lastJsonObject(out);
      // The tail, always — not only when the JSON is missing. A `die()` in the
      // CLI writes its reason to stderr and exits, and on several paths it does
      // that WITHOUT printing any JSON at all even under `--json`; those runs
      // used to reach the results file as `error: null`, which is the least
      // useful thing a failed measurement can say. Preferring stderr here is the
      // same split from the other side: that is where the CLI says what went
      // wrong.
      const source = err.trim() ? err : out;
      const tail = source.trim().split("\n").slice(-12).join("\n");
      done({ ...r, json, reservedMs, slug, reservedUrl, tail, t0 });
    };
    const timer = setTimeout(() => finish({ json: null, code: null, timedOut: true }), opts.budgetMs);
    const take = (chunk: string, stream: "out" | "err") => {
      if (stream === "out") out += chunk; else err += chunk;
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        opts.onLine(line);
        // The reserve is done and the URL exists — the URL-first claim, on a
        // clock, and the earliest sight of what this deploy is called. See
        // `reserveLine`.
        const reserved = reservedMs === null ? reserveLine(line) : null;
        if (reserved) {
          reservedMs = Date.now() - t0;
          slug = reserved.slug;
          reservedUrl = reserved.url;
        }
      }
    };
    // The reserve line is scanned on both: it is `print`ed to stdout today, and
    // a harness that silently stops timing the URL-first promise because a log
    // line moved is worse than one that looks in both places.
    child.stdout.on("data", (d) => take(d.toString(), "out"));
    child.stderr.on("data", (d) => take(d.toString(), "err"));
    child.on("error", (e) => finish({ json: { ok: false, error: e.message }, code: null, timedOut: false }));
    child.on("close", (code) => finish({ json: null, code, timedOut: false }));
  });
}

/**
 * Wait until the address serves the APP, not our own page about the app.
 *
 * The room answers 200 on `/` while a build is running — deliberately, since the
 * URL is handed out before anything exists. So "polled until 200" is not a
 * measurement of anything: it would succeed against a page that says the app is
 * still coming. `x-supersonic-page` is set on every page the proxy writes
 * itself (services/proxy/src/index.ts), and its ABSENCE is the signal that a
 * response came from the deployed app.
 */
async function firstOk(url: string, e: Expect, budgetMs: number, token: string): Promise<{ ms: number | null; reason: string }> {
  const started = Date.now();
  const target = url.replace(/\/$/, "") + (e.path ?? "/");
  let last = "never answered";
  while (Date.now() - started < budgetMs) {
    try {
      // AS THE OWNER, which is what the harness is. A new app's `visibility` is
      // `private` by default and the edge answers an anonymous request with 401
      // — so an unauthenticated probe reports "deployed but never served the
      // app" for every deploy that worked perfectly. On 10 Aug the first green
      // deploy of the day, `broken` (live in 239s, `ready: true`), was recorded
      // as a failure for exactly this reason, and a batch of ten of them would
      // have read as a total outage.
      //
      // Making the app public instead would measure a different product: it
      // spends the plan's public-app allowance and changes the thing being
      // measured. The question here is "does this address serve the app", and
      // the owner is entitled to that answer.
      const res = await fetch(target, {
        redirect: "manual",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const ours = res.headers.get("x-supersonic-page");
      if (ours) {
        last = `still our ${ours} page (${res.status})`;
      } else {
        const want = e.status ?? 200;
        if (res.status === want) {
          if (!e.body) return { ms: Date.now() - started, reason: `${res.status}` };
          const text = await res.text();
          if (text.includes(e.body)) return { ms: Date.now() - started, reason: `${res.status} and body matched` };
          last = `${res.status} but body did not contain ${JSON.stringify(e.body)}`;
        } else {
          last = `app answered ${res.status}, wanted ${want}`;
        }
      }
    } catch (err) {
      last = `request failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ms: null, reason: last };
}

/**
 * Whether a platform failure is what went wrong.
 *
 * Kept deliberately narrow and separate from the product's own classifier: this
 * one only has to answer "should this row count against the deploy engine", and
 * a quota error or an IAM refusal says nothing about whether we can deploy the
 * repository. Folding those into the failure rate makes the platform's worst
 * afternoon look like a regression in the product.
 */
function isPlatform(error: string): boolean {
  return /quota|429|rate limit|resource exhausted|permission|forbidden|403|iam|could not start the deploy|503/i.test(error);
}

/* -------------------------------------------------------------------------- */
/* The batch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ask the control plane what became of this deploy.
 *
 * Deliberately over HTTP and not over the database. The harness runs on a laptop
 * where Postgres is reachable only through cloud-sql-proxy, and the whole reason
 * a red row must explain itself is that the person reading it has not set that
 * up. `deploy-status` needs nothing but the token the deploy already used.
 *
 * The `stage` it returns is the last stage the pipeline entered, which is the
 * answer to "where did it break" — `deploy_stages` holds the full timeline and
 * the report joins it in by run_id when a database is at hand.
 */
async function askServer(slug: string, url: string, token: string): Promise<{ status: string | null; stage: string | null; error: string | null }> {
  try {
    const res = await fetch(`${url}/api/apps/${encodeURIComponent(slug)}/deploy-status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { status: null, stage: null, error: null };
    const body = await res.json() as { deploy?: { status?: string; stage?: string; error?: string } | null };
    const d = body.deploy;
    if (!d) return { status: null, stage: null, error: null };
    return { status: d.status ?? null, stage: d.stage ?? null, error: d.error ?? null };
  } catch {
    // A harness that cannot reach the server still has a row to write. Silence
    // here reads as "not asked", which the null makes explicit.
    return { status: null, stage: null, error: null };
  }
}

/**
 * The deploy's own error lines, oldest first.
 *
 * Only the ones marked ERROR, because the log is mostly narration and a red row
 * that carries three hundred lines of `building…` is as unreadable as one that
 * carries nothing. Oldest first and capped from the FRONT: the first error is
 * the cause and everything after it is consequence — `exit code: 1`, `build step
 * 0 failed`, `couldn't get it live` are three restatements of one event, and
 * keeping the tail instead would keep exactly those three.
 */
async function askLog(slug: string, url: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/api/apps/${encodeURIComponent(slug)}/logs`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { logs?: Array<{ message?: string; time?: string; severity?: string }> };
    // ERROR lines AND the repair agent's own narration.
    //
    // ERROR alone was the first attempt and it threw away the best diagnosis this
    // harness has produced. `epic-stack`'s real cause — "error: Environment
    // variable not found: DATABASE_URL" — was logged at INFO, as an `agent · …`
    // line, because it is the agent thinking out loud about what it found. The
    // ERROR lines said only "codex couldn't get it live after 0 redeploys",
    // which is the outcome restated three times. The agent reads the build
    // output we do not keep, so its narration is often the only surviving
    // account of what actually went wrong.
    const keep = (l: { message?: string; severity?: string }) => {
      if (!l.message) return false;
      if (l.severity === "ERROR") return true;
      return /^agent[ ·:]/.test(String(l.message).trim());
    };
    const lines = (body.logs ?? [])
      .filter(keep)
      .sort((a, b) => String(a.time).localeCompare(String(b.time)))
      .map((l) => String(l.message).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!lines.length) return null;
    // From the front: the first error is the cause and the rest is consequence.
    // `exit code: 1`, `build step 0 failed` and `couldn't get it live` are three
    // restatements of one event, and keeping the tail would keep exactly those.
    return lines.slice(0, 25).join("\n").slice(0, 6000);
  } catch {
    return null;
  }
}

async function deleteApp(slug: string, url: string, token: string): Promise<void> {
  try {
    await fetch(`${url}/api/apps/${encodeURIComponent(slug)}/delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch { /* cleanup is best effort — a leaked bench app is not a lost measurement */ }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.SUPERSONIC_TOKEN || "";
  // Only the paths that actually deploy need it. A dry run exists precisely so
  // the matrix can be checked before anyone has credentials in their shell.
  if (!args.importOnly && !args.dryRun && !token) {
    die("SUPERSONIC_TOKEN is not set — the harness deploys as a real user, so it needs a real token");
  }

  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${args.batch}-${args.target}.jsonl`);

  if (args.importOnly) return importRows(args.importOnly);

  const projects = corpus().filter((p) => !args.only || args.only.includes(p.key));
  if (!projects.length) die(`no projects matched --only ${args.only?.join(",")}`);

  // A batch name that has already been written to is refused rather than
  // appended to. Rows accumulate in this file by design — that is what keeps a
  // batch alive through a database outage at minute ninety — and the same
  // property means a re-run under a name someone has used before silently
  // interleaves two different runs of two different builds of the product into
  // one file that reports them as a single measurement. Which is exactly what
  // was about to happen after the first batch of 10 Aug was abandoned mid-flight.
  if (!args.dryRun && existsSync(outFile) && readFileSync(outFile, "utf8").trim()) {
    die(`${outFile} already has rows in it — pick another --batch name, or move that file aside if you meant to redo it`);
  }

  console.log(`bench ${args.batch} · ${args.target} (${args.url}) · ${projects.length} projects · modes ${args.modes.join("+")} · ${args.reps} reps · ${args.concurrency} at a time`);
  if (args.concurrency > 1) {
    console.log(`durations from this batch are NOT comparable with a --concurrency 1 batch — these deploys queue behind each other`);
  }
  console.log(`writing ${outFile}\n`);
  if (args.dryRun) {
    // An upper bound, not a plan. The real lanes pull from a shared queue as
    // they free up, which can only beat this fixed round-robin; and every deploy
    // is charged its full budget here, which is roughly double what one costs.
    // Both errors point the same way on purpose — a dry run is for finding out
    // whether the batch fits in the time available, and the useful answer to
    // that is the one that cannot be an underestimate.
    const queue = [...projects].sort((a, b) => b.budgetS - a.budgetS);
    const lanes: Project[][] = Array.from({ length: Math.min(args.concurrency, queue.length) }, () => []);
    queue.forEach((p, i) => lanes[i % lanes.length].push(p));
    const cells = args.modes.length * args.reps;
    let worst = 0;
    for (const [i, lane] of lanes.entries()) {
      const budget = lane.reduce((a, p) => a + p.budgetS * cells, 0);
      worst = Math.max(worst, budget);
      console.log(`  lane ${i + 1}: ${lane.map((p) => p.key).join(", ")}  (≤ ${(budget / 60).toFixed(0)} min)`);
    }
    console.log(`\n  worst case ${(worst / 60).toFixed(0)} min · ${projects.length * cells} deploys`);
    return;
  }

  // Projects run in parallel lanes; the cells WITHIN a project stay sequential.
  //
  // That split is not a compromise, it is the only arrangement that is correct.
  // A project's own cells cannot overlap — warm means "the same app again" and
  // cold means "delete it first", so two of them at once would be racing over
  // one slug. Different projects have no such relationship.
  //
  // What parallelism costs is comparability, and it costs it completely: these
  // deploys queue behind one shared Cloud Build pool and each other, so every
  // duration in a batch above concurrency 1 describes the batch. That is why the
  // number is written onto every row (see `Cell.concurrency`) instead of being
  // left as a fact about how the command happened to be invoked. A run that
  // wants to measure time asks for `--concurrency 1` and pays the hours.
  //
  // Heaviest first: with lanes of unequal length the tail is decided by whichever
  // long project starts last, so starting the long ones first is worth more than
  // any cleverness about how they are packed.
  const queue = [...projects].sort((a, b) => b.budgetS - a.budgetS);
  // The live view's data source. Written beside the results, under the same
  // batch name, so a finished batch keeps the record of how it unfolded and not
  // only of how it ended.
  const status = new Status(
    join(outDir, `${args.batch}-${args.target}.status.json`),
    { batch: args.batch, target: args.target, url: args.url, concurrency: args.concurrency, startedAt: Date.now() },
    queue.map((p) => p.key),
  );
  console.log(`live view: npm run bench:watch -- --batch ${args.batch}${args.target === "local" ? " --target local" : ""}\n`);

  let next = 0;
  const lanes = Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
    for (;;) {
      const p = queue[next++];
      if (!p) return;
      await runProject(p, args, token, outFile, status);
    }
  });
  await Promise.all(lanes);
  status.finish();

  console.log(`\ndone · ${outFile}`);
  await importRows(outFile);
}

/**
 * Every cell of one project, in order, and the app cleaned up after.
 *
 * One lane's worth of work. Lifted out of `main` so the lanes have something to
 * call, but the body is what the sequential version did — the ordering rules
 * inside a project did not change, only how many projects are doing this at
 * once.
 */
async function runProject(p: Project, args: Args, token: string, outFile: string, status: Status): Promise<void> {
  let slug: string | null = null;
  for (const mode of args.modes) {
    for (let rep = 0; rep < args.reps; rep++) {
      status.update(p.key, { state: "deploying", mode, rep, startedAt: Date.now(), line: null, lines: [], phase: null, lastLineAt: null });
      // Cold means an app that does not exist yet, which is what a first-time
      // user has. Warm is the same app deployed again — the case every user
      // is in from their second deploy onward, and a materially different one
      // because of the plan, clone and build caches.
      if (mode === "cold" && slug) { await deleteApp(slug, args.url, token); slug = null; }

      const cell = await runCellWithRoom(p, mode, rep, args, token, status);
      slug = cell.slug ?? slug;
      appendFileSync(outFile, JSON.stringify(cell) + "\n");
      status.update(p.key, {
        state: "done", slug: cell.slug, url: cell.url,
        reservedMs: cell.reservedMs, activatedMs: cell.activatedMs, firstOkMs: cell.firstOkMs,
        outcome: cell.outcome, verdict: cell.verdict,
        // The cause, in the order the useful answer tends to be found: the first
        // error line the deploy logged, then what the server concluded, then
        // what the CLI managed to say.
        cause: cell.serverLog?.split("\n")[0] ?? cell.serverError ?? cell.error ?? cell.reason,
      });

      // One finished line, printed whole. The old code opened the line before
      // the deploy and closed it after, which reads well with one lane and is
      // unreadable with five interleaving into the same terminal.
      const secs = (n: number | null) => (n === null ? "—" : `${(n / 1000).toFixed(1)}s`);
      // The stage first and the message second, because "where" is what decides
      // what to do next and "what" is often three hundred characters of gcloud.
      const why = cell.serverStage ? ` · stage ${cell.serverStage.slice(0, 60)}` : "";
      console.log(
        `▸ ${`${p.key} ${mode} #${rep}`.padEnd(28)} ${cell.verdict ?? cell.outcome} · live ${secs(cell.activatedMs)} · answering ${secs(cell.firstOkMs)}`
        + why + ((cell.serverError ?? cell.error) ? ` · ${(cell.serverError ?? cell.error)!.replace(/\s+/g, " ").slice(0, 100)}` : ""),
      );
    }
  }
  if (slug && !args.keep) await deleteApp(slug, args.url, token);
}

/**
 * A cell, retried while the account is at its concurrent-deploy ceiling.
 *
 * `/api/deploy/reserve` refuses a caller with too many deploys in flight, and it
 * refuses with a 429 — which `isPlatform` reads as platform blame and excludes
 * from every rate. So without this, running more lanes than the plan allows does
 * not fail loudly: it quietly drops projects out of the batch as `platform`, and
 * the report says the run was clean because those rows are not counted anywhere.
 * A ceiling we hit is a thing to wait behind, not a measurement.
 */
async function runCellWithRoom(p: Project, mode: "cold" | "warm", rep: number, args: Args, token: string, status: Status): Promise<Cell> {
  // Twenty attempts, thirty seconds apart — ten minutes of patience.
  //
  // Three minutes was the first guess and it was aimed at the wrong thing: a slot
  // is not usually busy for seconds, it is held by another deploy for as long as
  // that deploy takes, and a run row abandoned mid-build holds one until the job
  // finishes or an hour passes. `2048` spent this whole window retrying in the
  // batch of 10 Aug and never got in. Waiting is not measuring, so it costs
  // nothing but wall clock; a project dropped at the ceiling is a project not
  // measured at all, and it lands in the results as `platform` — excluded from
  // every rate, which is to say invisible.
  for (let attempt = 0; ; attempt++) {
    const cell = await runCell(p, mode, rep, args, token, status);
    const atCeiling = cell.error && /deploys building|429/i.test(cell.error);
    if (!atCeiling || attempt >= 20) return cell;
    status.update(p.key, { state: "waiting", waits: attempt + 1, line: cell.error ?? null });
    // The COUNT stays in the line. Trimming it to `attempt n/20` made the output
    // quieter and threw away the only diagnostic it carried: how many deploys the
    // server thinks are running, which is the number that says whether the wait
    // is other people's work or our own wreckage.
    const says = cell.error?.match(/You already have \d+ deploys? building/)?.[0] ?? cell.error?.slice(0, 60) ?? "";
    console.log(`  ${p.key} ${mode} #${rep} — waiting for a deploy slot (${attempt + 1}/20 · ${says})`);
    await new Promise((r) => setTimeout(r, 30_000));
    status.update(p.key, { state: "deploying", startedAt: Date.now() });
  }
}

async function runCell(p: Project, mode: "cold" | "warm", rep: number, args: Args, token: string, status: Status): Promise<Cell> {
  const budgetMs = p.budgetS * 1000;
  const startedAt = new Date().toISOString();
  // The CLI's stream, kept instead of discarded. This is the pipeline narrating
  // itself as it happens — "Pulling…", "Detecting stack…", "Building…", "Live
  // at…" — and it was being thrown away by an empty callback, which is the
  // whole reason a running batch was invisible. Nothing had to be added to the
  // product to see inside a deploy; it was already coming down the wire.
  const res = await ship(p, { url: args.url, token, budgetMs, onLine: (l) => status.say(p.key, l) });
  const j = res.json ?? {};
  const activatedMs = Date.now() - res.t0;

  const cell: Cell = {
    batch: args.batch, target: args.target, project: p.key,
    repoUrl: p.repo ?? `folder:${p.folder}`, repoSha: p.sha,
    mode, rep, concurrency: args.concurrency,
    runId: (j.runId as string) ?? null,
    // The reserve line's slug is the fallback, not the other way round: the JSON
    // is more authoritative when it exists, and the reserve line is the only one
    // that exists when it does not.
    slug: (j.slug as string) ?? res.slug,
    url: (j.url as string) ?? res.reservedUrl,
    startedAt,
    reservedMs: res.reservedMs,
    activatedMs: j.ok ? activatedMs : null,
    firstOkMs: null,
    finishedAt: null,
    outcome: "failed",
    verdict: null,
    reason: null,
    // Falls all the way through to what the CLI last said. A row that records a
    // failure and no reason for it costs the whole deploy it took to produce.
    error: (j.error as string)
      ?? (res.timedOut ? `the harness gave up after ${p.budgetS}s` : null)
      ?? (res.code ? `the CLI exited ${res.code} without a result · ${res.tail.replace(/\s+/g, " ").slice(-300)}` : null)
      ?? (j.ok ? null : `the CLI produced no result · ${res.tail.replace(/\s+/g, " ").slice(-300)}`),
    serverStatus: null, serverStage: null, serverError: null, serverLog: null,
  };

  // What the server thinks, before anything else is decided. Asked for every
  // cell and not only the red ones: a deploy the CLI called live and the server
  // calls failed is the most interesting row this harness could produce, and it
  // is unreachable if the question is only asked after a failure.
  if (cell.slug) {
    const seen = await askServer(cell.slug, args.url, token);
    cell.serverStatus = seen.status;
    cell.serverStage = seen.stage;
    cell.serverError = seen.error;
    // The log only when something went wrong. A green deploy's errors are not
    // interesting and the call is not free — but a red row without them is a
    // row somebody has to go and investigate by hand, which is the whole
    // distinction between a tripwire and an instrument.
    if (cell.outcome !== "live" || seen.status === "failed") {
      cell.serverLog = await askLog(cell.slug, args.url, token);
    }
  }

  if (res.timedOut) cell.outcome = "timeout";
  else if (j.ok) cell.outcome = "live";
  else if (cell.error && /cannot tell what this app is|refus|ambiguous/i.test(cell.error)) cell.outcome = "refused";
  else cell.outcome = "failed";

  // The app said it is live. Ask the app.
  if (cell.outcome === "live" && cell.url) {
    // A phase of its own in the live view, because it is a real wait with a real
    // question attached: the pipeline has said live, and this is the gap before
    // the address agrees.
    status.update(p.key, { state: "probing", slug: cell.slug, url: cell.url, activatedMs, phase: "live" });
    const probe = await firstOk(cell.url, p.expect, Math.max(60_000, budgetMs / 2), token);
    cell.firstOkMs = probe.ms === null ? null : activatedMs + probe.ms;
    if (probe.ms === null) {
      // Deployed, declared live, and does not answer. That is a failure of the
      // product, not of the harness, and recording it as a pass because the
      // pipeline was pleased with itself is how this whole exercise would become
      // decorative.
      cell.outcome = "failed";
      cell.error = `deploy reported live but the URL never served the app: ${probe.reason}`;
    }
  }

  cell.finishedAt = new Date().toISOString();
  const verdict = judge(p, cell);
  cell.verdict = verdict.verdict;
  cell.reason = verdict.reason;
  return cell;
}

function judge(p: Project, cell: Cell): { verdict: Cell["verdict"]; reason: string } {
  if (cell.error && isPlatform(cell.error)) {
    return { verdict: "platform", reason: "the platform got in the way — this row does not count for or against the engine" };
  }
  // The harness stopped watching; the deploy did not stop. Not a failure of
  // anything except this run's patience, and scoring it as one is how a budget
  // somebody guessed at becomes a fact about the product. On 10 Aug two rows
  // recorded `failed` at 150s and 198s while the server was still building both
  // of them, and with no server-side view there was no way to know.
  if (cell.outcome !== "live" && cell.serverStatus === "building") {
    return {
      verdict: "inconclusive",
      reason: `the harness gave up after ${p.budgetS}s while the server was still building (stage: ${cell.serverStage ?? "unknown"})`,
    };
  }
  if (p.expect.outcome === "unknown") {
    // Not a pass and not a failure: nobody has said yet what this project is
    // supposed to do. Recorded, reported, and excluded from any rate until a
    // human calibrates it.
    return { verdict: null, reason: "no expectation on file yet — this batch is the baseline" };
  }
  if (p.expect.outcome === cell.outcome) return { verdict: "pass", reason: `expected ${p.expect.outcome}` };
  return { verdict: "fail", reason: `expected ${p.expect.outcome}, got ${cell.outcome}` };
}

/* -------------------------------------------------------------------------- */
/* Into the database                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Import a results file into `bench_runs`.
 *
 * Separate from the run, and re-runnable, because the database is reachable
 * from a laptop only through cloud-sql-proxy and a batch must not be lost
 * because that died. The JSONL is the raw record; this is the queryable copy.
 */
async function importRows(file: string): Promise<void> {
  if (!existsSync(file)) die(`no such results file: ${file}`);
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Cell);
  if (!rows.length) return;
  let pool;
  try {
    ({ getPool: pool } = await import("@/lib/db"));
  } catch (e) {
    console.error(`could not load the database module — the results are still in ${file}: ${e}`);
    return;
  }
  const db = (pool as (n: string) => { query: (q: string, v?: unknown[]) => Promise<unknown>; end: () => Promise<void> })("supersonic_platform");
  try {
    for (const r of rows) {
      await db.query(
        `INSERT INTO bench_runs
           (batch, target, project, repo_url, repo_sha, mode, rep, concurrency, run_id, slug, url,
            started_at, reserved_ms, activated_ms, first_ok_ms, finished_at,
            outcome, verdict, reason, error,
            server_status, server_stage, server_error, server_log)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [r.batch, r.target, r.project, r.repoUrl, r.repoSha, r.mode, r.rep, r.concurrency ?? 1,
         r.runId, r.slug, r.url,
         r.startedAt, r.reservedMs, r.activatedMs, r.firstOkMs, r.finishedAt,
         r.outcome, r.verdict, r.reason, r.error,
         r.serverStatus ?? null, r.serverStage ?? null, r.serverError ?? null, r.serverLog ?? null],
      );
    }
    console.log(`imported ${rows.length} rows into bench_runs`);
  } catch (e) {
    console.error(`import failed — the results are still in ${file}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
