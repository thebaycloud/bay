import { getPool } from "../db";
import { ACTIVATION_STAGE } from "../stage-names";
import type { RawStage, StageOutcome } from "./attempts";

const DB = "supersonic_platform";

/**
 * Everything the analytics page reads out of production, and nothing it writes.
 *
 * The database is shared production, so read-only here is not a convention —
 * it is enforced twice. Every statement runs inside `BEGIN READ ONLY`, which
 * makes Postgres itself reject a write whatever the SQL says, and every
 * statement is checked against `assertReadOnly` before it is sent, so a mistake
 * fails in review rather than at a transaction boundary. The transaction is the
 * guarantee; the guard is there to make the mistake obvious.
 *
 * A READ THAT FAILS SAYS SO
 *
 * These reads used to return an empty array on any error. That made a broken
 * query indistinguishable from a quiet week — on a page whose entire job is to
 * be believed, and against tables whose column names were read off `lib/*.ts`
 * rather than a migration, because `deploys` and `deploy_events` are created by
 * the code that writes them and appear in no migration at all.
 *
 * So every read returns its rows AND the database's own words when it fails.
 * The page keeps rendering — one broken panel must not take the others down
 * with it — but the broken panel says what broke. "column deploys.finished_at
 * does not exist" is worth more than a clean-looking empty box.
 */

/** Statement keywords that have no business in this file. */
const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge|vacuum|refresh|comment|set\s+(?!transaction))\b/i;

export function assertReadOnly(sql: string): void {
  // Strip string literals and comments first: a WHERE clause may legitimately
  // match on the word "delete" in a stored error message.
  const bare = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ");
  const hit = bare.match(FORBIDDEN);
  if (hit) throw new Error(`analytics queries must be read-only; found "${hit[0]}"`);
}

/** Rows, and — when there are none because the read broke — why. */
export interface Read<T> {
  rows: T[];
  /** The database's own message. Null when the read succeeded. */
  error: string | null;
}

/**
 * Run one statement in a read-only transaction.
 *
 * The connection is taken from the pool and always returned, including when the
 * query throws — a leaked client on a control plane with `max: 3` takes a third
 * of production's database capacity with it.
 */
async function read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  assertReadOnly(sql);
  const client = await getPool(DB).connect();
  try {
    await client.query("BEGIN READ ONLY");
    const r = await client.query(sql, params);
    await client.query("COMMIT");
    return r.rows as T[];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Anything that must never reach a rendered page, however it got into an error.
 *
 * Belt and braces on top of `readErrorDetail`, which already refuses to render
 * connection-level errors verbatim. A message is data from outside this file, so
 * it is scrubbed rather than trusted.
 */
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  // Ordered: the connection-string rule runs first so that user:pass@host is
  // taken whole, rather than the address rule carving the host out of it and
  // leaving the credentials behind.
  [/\b(?:postgres(?:ql)?|pg):\/\/\S+/gi, "[connection string redacted]"],
  // No \b before "password": the thing to catch is PGPASSWORD=…, where the
  // word is glued to a prefix and a word boundary never matches.
  [/\w*password\w*\s*[=:]\s*\S+/gi, "password=[redacted]"],
  [/\/cloudsql\/\S+/g, "[socket path redacted]"],
  // The page now renders user emails, so an error is a way for one to escape
  // into a log or a message. A SELECT rarely quotes a row value, but "rarely"
  // is not a property to rest an identity leak on: Postgres does quote values
  // in constraint and type-coercion errors, and this page's whole job is to
  // read tables whose contents are people.
  [/\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email redacted]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[address redacted]"],
];

export function redact(message: string): string {
  return REDACTIONS.reduce((m, [pattern, with_]) => m.replace(pattern, with_), message);
}

/**
 * What actually went wrong, in words that are safe to render.
 *
 * Two very different kinds of failure end up here, and only one of them is safe
 * to quote:
 *
 * - A **Postgres server error** carries a five-character SQLSTATE. Its message
 *   is a diagnostic about the SQL — `column "finished_at" does not exist` — and
 *   is exactly what an operator needs. Quoted verbatim.
 * - A **connection or driver error** has a Node code (`ECONNREFUSED`,
 *   `ETIMEDOUT`, `ENOTFOUND`) and its message routinely carries the host, the
 *   port, the socket path or the user. None of that helps diagnose a dashboard
 *   panel, and a page is the wrong place for it, so only the class of failure is
 *   reported.
 *
 * First line only either way: a stack trace on the page helps nobody, and the
 * log keeps the stack. It does NOT keep the raw error — both branches that can
 * carry data return `redact(...)`, and the stack is redacted at the call site.
 * That changed when this page began rendering user emails, and the comment said
 * otherwise for one commit. A note claiming a weaker privacy property than the
 * code provides is the kind that gets acted on: the next reader restores raw
 * logging on its authority.
 */
export function readErrorDetail(e: unknown): string {
  const err = e as { code?: unknown; severity?: unknown } | null;
  const codeStr = typeof err?.code === "string" ? err.code : "";
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split("\n")[0].trim();

  // `severity` is what tells the two apart, NOT the shape of the code. node-pg
  // sets it ("ERROR", "FATAL") on every error the server sent, and never on one
  // the driver raised. Matching SQLSTATE by shape looked equivalent and was not:
  // it is five alphanumerics, and so are the Node codes EPIPE and EPERM, so a
  // broken pipe was being quoted verbatim — address, port and all — down the
  // path meant for safe server diagnostics.
  const fromServer = typeof err?.severity === "string" && err.severity.length > 0;
  if (fromServer) return redact(first || `the database refused the query (${codeStr || "no code"})`);

  if (codeStr) return `could not reach the database (${codeStr})`;
  return redact(first || "the read failed without saying why");
}

/**
 * The sentence a panel shows, naming the read that produced it.
 *
 * The driver's message alone is not actionable — `column "finished_at" does not
 * exist` is only useful once you know which read and which table it came from,
 * and the panel it lands in is not enough to tell you when several panels share
 * a source. So the name travels with the message from the point of failure,
 * rather than being attached by whoever renders it.
 */
export function readErrorMessage(e: unknown, source: string, relation: string): string {
  return `${source} (reading ${relation}): ${readErrorDetail(e)}`;
}

/**
 * A read whose failure becomes a visible panel rather than an empty one.
 *
 * HANDLED VERSUS UNHANDLED
 *
 * This is the unhandled case: the caller has no second attempt, so it is
 * asserting the query must work, and a failure means nothing recovers. Those
 * failures must reach the page.
 *
 * A caller that genuinely probes — `users()` asks for the rich shape and falls
 * back to the bare one when `plan`/`status` have not been migrated yet — calls
 * this twice and reports `error: null` when the fallback succeeds. That is a
 * recovery, and there is nothing to tell an operator about. Only a failure that
 * nothing recovers from is worth a red panel.
 */
async function attempt<T>(
  where: { source: string; relation: string },
  sql: string,
  params: unknown[] = [],
): Promise<Read<T>> {
  try {
    return { rows: await read<T>(sql, params), error: null };
  } catch (e) {
    // Logged scrubbed, not raw.
    //
    // This used to log the error object itself, on the reasoning that a log is
    // a safer place than a page. That stopped being true when this page started
    // rendering user emails: logs are shipped, searched and retained, and an
    // identity in one is harder to retract than an identity on a screen. The
    // stack is kept because it names code paths rather than data, and it is
    // scrubbed too rather than trusted to contain none.
    const stack = e instanceof Error && e.stack ? `\n${redact(e.stack)}` : "";
    console.error(`analytics read failed: ${where.source} (${where.relation}): ${readErrorDetail(e)}${stack}`);
    return { rows: [], error: readErrorMessage(e, where.source, where.relation) };
  }
}

export interface Window {
  from: Date;
  to: Date;
  days: number;
}

export function windowOf(days: number, now: Date = new Date()): Window {
  const to = now;
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to, days };
}

/**
 * How many rows any one query may return.
 *
 * A cap rather than pagination because this page summarises; what matters is
 * that it says so when it hits one, rather than quietly reporting a percentile
 * over the first 200,000 of something.
 */
export const ROW_CAP = 200_000;

export interface UserRow {
  id: string;
  email: string;
  createdAt: Date;
  plan: string | null;
  status: string | null;
  provider: string | null;
}

export async function users(): Promise<Read<UserRow>> {
  // `plan` and `status` arrive in migrations 005 and 007. A database that has
  // not had them applied still answers the rest, so a narrower read is tried
  // second — and if BOTH fail, the second failure is the one reported, because
  // that is the one meaning the users table itself cannot be read.
  const full = await attempt<{ id: string; email: string; created_at: Date; plan: string | null; status: string | null; provider: string | null }>(
    { source: "users", relation: "users" },
    `SELECT id, email, created_at, plan, status, provider FROM users ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  if (!full.error) {
    return {
      rows: full.rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at, plan: r.plan, status: r.status, provider: r.provider })),
      error: null,
    };
  }

  const bare = await attempt<{ id: string; email: string; created_at: Date; provider: string | null }>(
    { source: "users", relation: "users" },
    `SELECT id, email, created_at, provider FROM users ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  return {
    rows: bare.rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at, plan: null, status: null, provider: r.provider })),
    error: bare.error,
  };
}

export interface AppRow {
  slug: string;
  ownerId: string;
  status: string;
  visibility: string;
  createdAt: Date;
}

export async function apps(): Promise<Read<AppRow>> {
  const r = await attempt<{ slug: string; owner_id: string; status: string; visibility: string; created_at: Date }>(
    { source: "apps", relation: "apps" },
    `SELECT slug, owner_id, status, visibility, created_at FROM apps ORDER BY created_at LIMIT ${ROW_CAP}`,
  );
  return {
    rows: r.rows.map((x) => ({ slug: x.slug, ownerId: x.owner_id, status: x.status, visibility: x.visibility, createdAt: x.created_at })),
    error: r.error,
  };
}

/**
 * Stage rows in a window, plus whether the cap cut them off.
 *
 * Ordered by slug then start so the sessionizer's own sort has almost nothing to
 * do, and so a truncated read loses whole apps from the end rather than half a
 * deploy from every app.
 */
export async function stages(w: Window): Promise<Read<RawStage> & { truncated: boolean }> {
  const r = await attempt<{ slug: string; lane: string; stage: string; started_at: Date; ended_at: Date | null; outcome: StageOutcome | null; runtime: string | null; cold: boolean | null }>(
    { source: "stages", relation: "deploy_stages" },
    `SELECT slug, lane, stage, started_at, ended_at, outcome, runtime, cold
       FROM deploy_stages
      WHERE started_at >= $1 AND started_at <= $2
      ORDER BY slug, started_at
      LIMIT ${ROW_CAP + 1}`,
    [w.from, w.to],
  );
  const truncated = r.rows.length > ROW_CAP;
  return {
    rows: r.rows.slice(0, ROW_CAP).map((x) => ({
      slug: x.slug,
      lane: x.lane,
      runtime: x.runtime,
      cold: x.cold,
      stage: x.stage,
      startedAt: x.started_at,
      endedAt: x.ended_at,
      outcome: x.outcome,
    })),
    truncated,
    error: r.error,
  };
}

/**
 * The earliest recorded stage for every app, whatever the window.
 *
 * Time-to-first-success is measured from signup, which can be months before the
 * window starts, so it cannot be answered from a windowed read.
 */
export interface FirstDeployRow {
  slug: string;
  firstStageAt: Date;
  firstSuccessAt: Date | null;
}

export async function firstDeploys(): Promise<Read<FirstDeployRow>> {
  const r = await attempt<{ slug: string; first_stage_at: Date; first_success_at: Date | null }>(
    { source: "firstDeploys", relation: "deploy_stages" },
    // The stage name is interpolated from the shared constant rather than typed
    // here. This filter has no WHERE and no window, so a pipeline that stops
    // emitting that exact string does not make this query fail — it makes
    // `first_success_at` null for every app, and activation reads as a product
    // problem rather than a wiring one.
    `SELECT slug,
            min(started_at) AS first_stage_at,
            min(ended_at) FILTER (WHERE stage = '${ACTIVATION_STAGE}' AND outcome = 'ok') AS first_success_at
       FROM deploy_stages
      GROUP BY slug
      LIMIT ${ROW_CAP}`,
  );
  return {
    rows: r.rows.map((x) => ({ slug: x.slug, firstStageAt: x.first_stage_at, firstSuccessAt: x.first_success_at })),
    error: r.error,
  };
}

/**
 * The latest deploy record per app: status, the reason it failed, and who owns it.
 *
 * `deploys` holds ONE row per slug, upserted — it is the current state of an
 * app, not a history. So this answers "what went wrong last time" for each app
 * and can never answer "how often does that go wrong".
 */
export interface DeployStateRow {
  slug: string;
  ownerId: string | null;
  status: string;
  error: string | null;
  updatedAt: Date | null;
  finishedAt: Date | null;
}

export async function deployStates(): Promise<Read<DeployStateRow>> {
  const r = await attempt<{ slug: string; owner_id: string | null; status: string; error: string | null; updated_at: Date | null; finished_at: Date | null }>(
    { source: "deployStates", relation: "deploys" },
    `SELECT slug, owner_id, status, error, updated_at, finished_at FROM deploys LIMIT ${ROW_CAP}`,
  );
  return {
    rows: r.rows.map((x) => ({
      slug: x.slug,
      ownerId: x.owner_id,
      status: x.status,
      error: x.error,
      updatedAt: x.updated_at,
      finishedAt: x.finished_at,
    })),
    error: r.error,
  };
}

/**
 * Error events in the window.
 *
 * The one source that records a reason PER DEPLOY rather than per app — but
 * `pruneEvents` drops anything older than 7 days, so a window wider than a week
 * is answered by a table that has already forgotten most of it. The page says so
 * next to the number.
 */
export const EVENT_RETENTION_DAYS = 7;

export interface ErrorEventRow {
  slug: string;
  message: string;
  at: Date;
}

export async function errorEvents(w: Window): Promise<Read<ErrorEventRow>> {
  const r = await attempt<{ slug: string; message: string | null; at: Date }>(
    { source: "errorEvents", relation: "deploy_events" },
    `SELECT slug, event->>'message' AS message, at
       FROM deploy_events
      WHERE at >= $1 AND at <= $2 AND event->>'type' = 'error'
      ORDER BY at
      LIMIT ${ROW_CAP}`,
    [w.from, w.to],
  );
  return {
    rows: r.rows.filter((x) => x.message).map((x) => ({ slug: x.slug, message: x.message as string, at: x.at })),
    error: r.error,
  };
}

/**
 * How far back the event log actually goes.
 *
 * Reported rather than assumed: the retention sweep runs opportunistically when
 * a deploy starts, so on a quiet week the log holds more than seven days and on
 * a busy one it holds exactly seven. Either way the page should state the real
 * horizon rather than the intended one.
 */
export async function oldestEventAt(): Promise<{ at: Date | null; error: string | null }> {
  const r = await attempt<{ at: Date | null }>({ source: "oldestEventAt", relation: "deploy_events" }, `SELECT min(at) AS at FROM deploy_events`);
  return { at: r.rows[0]?.at ?? null, error: r.error };
}

/**
 * How accounts arrived: they came looking for us, or their agent chose us.
 *
 * `users.acquisition_kind` is written once per account, at a machine's first
 * sign-in, from a verbatim quote of what the user asked their agent for — see
 * lib/acquisition.ts and db/038. Aggregated in SQL rather than read as rows,
 * because unlike everything else on this page there is no per-user question to
 * ask of it and the raw column is a fragment of somebody's prompt.
 *
 * Windowed on `created_at`, so it answers "of the people who signed up in the
 * last N days" — which is the only form of this number worth watching. All-time
 * it is dominated by accounts that predate the column and can only go down.
 */
export interface AcquisitionRow {
  kind: string;
  users: number;
}

export async function acquisition(w: Window): Promise<Read<AcquisitionRow>> {
  // COALESCE and not a filter: accounts created in the window with no value are
  // the honest denominator. They are older CLIs that never sent one, and browser
  // signups where no terminal was involved — leaving them out would turn a 12%
  // coverage into a confident-looking 100%.
  const r = await attempt<{ kind: string; users: string }>(
    { source: "acquisition", relation: "users" },
    `SELECT COALESCE(acquisition_kind, 'not asked') AS kind, count(*) AS users
       FROM users
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY 1
      ORDER BY 2 DESC`,
    [w.from, w.to],
  );
  return { rows: r.rows.map((x) => ({ kind: x.kind, users: Number(x.users) })), error: r.error };
}

/**
 * The requests we are winning, in the words of the people making them.
 *
 * Only `chosen` — a quote that already names Bay says nothing about how anybody
 * found us. This is the actual product of the whole mechanism: the bit is a
 * chart, but the sentences are what tells you which need to write the next page
 * of documentation against.
 */
export interface AcquisitionQuoteRow {
  via: string;
  at: Date;
}

export async function acquisitionQuotes(w: Window, limit = 40): Promise<Read<AcquisitionQuoteRow>> {
  const r = await attempt<{ via: string; at: Date }>(
    { source: "acquisitionQuotes", relation: "users" },
    `SELECT acquisition_via AS via, acquisition_at AS at
       FROM users
      WHERE acquisition_kind = 'chosen' AND created_at >= $1 AND created_at <= $2
      ORDER BY acquisition_at DESC
      LIMIT ${Number(limit) | 0}`,
    [w.from, w.to],
  );
  return { rows: r.rows, error: r.error };
}
