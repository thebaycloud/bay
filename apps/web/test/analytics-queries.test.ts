import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertReadOnly, windowOf, ROW_CAP, readErrorMessage, readErrorDetail, redact } from "../lib/analytics/queries";

// Postgres is shared production. The transaction (`BEGIN READ ONLY`) is what
// actually stops a write; this guard is what makes the mistake visible before
// anyone runs it.

test("the statements this feature actually sends are accepted", () => {
  const real = [
    `SELECT id, email, created_at, plan, status, provider FROM users ORDER BY created_at LIMIT 100`,
    `SELECT slug, owner_id, status, visibility, created_at FROM apps ORDER BY created_at LIMIT 100`,
    `SELECT slug, lane, stage, started_at, ended_at, outcome FROM deploy_stages WHERE started_at >= $1 ORDER BY slug, started_at`,
    `SELECT slug, min(started_at) AS first_stage_at, min(ended_at) FILTER (WHERE stage = 'deploy' AND outcome = 'ok') AS first_success_at FROM deploy_stages GROUP BY slug`,
    `SELECT slug, owner_id, status, error, updated_at, finished_at FROM deploys`,
    `SELECT slug, event->>'message' AS message, at FROM deploy_events WHERE event->>'type' = 'error'`,
    `SELECT min(at) AS at FROM deploy_events`,
  ];
  for (const sql of real) assert.doesNotThrow(() => assertReadOnly(sql), sql);
});

test("column names that merely contain a verb are not writes", () => {
  // created_at, updated_at, deleted_at — the guard must not fire on these or it
  // would be turned off within a week.
  assert.doesNotThrow(() => assertReadOnly(`SELECT created_at, updated_at, deleted_at, offset_ms FROM t`));
});

test("every mutating statement is refused", () => {
  const bad = [
    `DELETE FROM users`,
    `UPDATE users SET plan = 'pro'`,
    `INSERT INTO apps(slug) VALUES('x')`,
    `DROP TABLE deploy_stages`,
    `TRUNCATE deploy_events`,
    `ALTER TABLE users ADD COLUMN x text`,
    `CREATE INDEX foo ON users(id)`,
    `GRANT ALL ON users TO public`,
    `SELECT 1; DELETE FROM apps`,
  ];
  for (const sql of bad) assert.throws(() => assertReadOnly(sql), /read-only/, sql);
});

// A failure reason stored in the database can contain any word at all, and a
// WHERE clause matching one must not look like a write.
test("a literal containing a verb is not a write", () => {
  assert.doesNotThrow(() => assertReadOnly(`SELECT * FROM deploys WHERE error LIKE '%delete failed%'`));
  assert.doesNotThrow(() => assertReadOnly(`SELECT * FROM t WHERE msg = 'could not create the container'`));
  // But hiding one after a real literal still fails.
  assert.throws(() => assertReadOnly(`SELECT 'delete' AS x; DROP TABLE users`), /read-only/);
});

test("a comment cannot smuggle a write past the guard, nor trip it needlessly", () => {
  assert.doesNotThrow(() => assertReadOnly(`SELECT 1 -- we never delete anything here\n`));
  assert.throws(() => assertReadOnly(`SELECT 1 /* x */ ; TRUNCATE t`), /read-only/);
});

// The strongest guard available without a database: nothing in the query module
// may contain a mutating statement at all.
test("the query module contains no mutating SQL anywhere in it", () => {
  const src = readFileSync(new URL("../lib/analytics/queries.ts", import.meta.url), "utf8");
  const statements = src.match(/`[^`]*\bFROM\b[^`]*`/gi) ?? [];
  assert.ok(statements.length >= 5, `expected to find the SQL literals, found ${statements.length}`);
  for (const s of statements) assert.doesNotThrow(() => assertReadOnly(s.slice(1, -1)), s);
});

test("a window runs back from now by the number of days asked for", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  const w = windowOf(30, now);
  assert.equal(w.to.getTime(), now.getTime());
  assert.equal(w.from.toISOString(), "2026-07-02T12:00:00.000Z");
  assert.equal(w.days, 30);
});

test("the row cap is a number the page can report", () => {
  assert.ok(Number.isInteger(ROW_CAP) && ROW_CAP > 0);
});

// ─── what a failed read is allowed to say ─────────────────────────────────────

/**
 * A Postgres server error, as node-postgres builds one: a SQLSTATE code AND a
 * severity. The severity is the part that identifies it as the server's own
 * diagnostic — see readErrorDetail.
 */
function serverError(message: string, code = "42703"): Error & { code: string; severity: string } {
  return Object.assign(new Error(message), { code, severity: "ERROR" });
}
/** A driver/connection error: Node code, message about the network. */
function connectionError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

// The whole point of surfacing failures: Postgres already names the defect, and
// that is what an operator needs to fix it.
test("a server error is quoted verbatim, because it names the defect", () => {
  assert.equal(readErrorDetail(serverError('column "finished_at" does not exist')), 'column "finished_at" does not exist');
  assert.equal(readErrorDetail(serverError('relation "deploy_events" does not exist', "42P01")), 'relation "deploy_events" does not exist');
});

// A connection error's message routinely carries the host, the port, the socket
// path or the user. None of it helps diagnose a panel, and a rendered page is
// the wrong place for it.
test("a connection error reports its class and never its address", () => {
  const e = connectionError("connect ECONNREFUSED 127.0.0.1:5433", "ECONNREFUSED");
  const out = readErrorDetail(e);
  assert.equal(out, "could not reach the database (ECONNREFUSED)");
  assert.ok(!out.includes("127.0.0.1"), "the host must not reach the page");
  assert.ok(!out.includes("5433"), "the port must not reach the page");
});

test("every connection failure class is reported without its detail", () => {
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EPIPE"]) {
    const out = readErrorDetail(connectionError(`something about /cloudsql/proj:region:inst and 10.0.0.1:5432`, code));
    assert.equal(out, `could not reach the database (${code})`);
  }
});

// Belt and braces: a message is data from outside this file, so it is scrubbed
// even on the path that is meant to be safe to quote.
test("credentials and connection details are redacted wherever they appear", () => {
  assert.equal(redact("postgres://admin:hunter2@db.internal:5432/app"), "[connection string redacted]");
  assert.equal(redact("PGPASSWORD=hunter2 rejected"), "password=[redacted] rejected");
  assert.equal(redact('password: "hunter2"'), "password=[redacted]");
  assert.match(redact("could not connect to /cloudsql/supersonic-deploy-prod:us-central1:pg"), /socket path redacted/);
  assert.equal(redact("connect to 10.1.2.3:5432 failed"), "connect to [address redacted] failed");
});

test("a server error carrying a connection string is still scrubbed", () => {
  const out = readErrorDetail(serverError("bad config postgres://u:p@h:5432/d"));
  assert.ok(!out.includes("hunter"), "no credential");
  assert.match(out, /connection string redacted/);
});

// Ordinary SQL diagnostics must survive redaction untouched, or the feature is
// useless — these are the messages the page exists to show.
test("redaction leaves an ordinary SQL diagnostic alone", () => {
  for (const m of [
    'column "finished_at" does not exist',
    'relation "deploy_events" does not exist',
    'column deploys.owner_id must appear in the GROUP BY clause',
    "operator does not exist: text >= timestamp with time zone",
  ]) {
    assert.equal(redact(m), m);
  }
});

// The driver message alone is not actionable — it has to arrive with the read
// and the table it came from.
test("the message names the read and the table it came from", () => {
  assert.equal(
    readErrorMessage(serverError('column "finished_at" does not exist'), "deployStates", "deploys"),
    'deployStates (reading deploys): column "finished_at" does not exist',
  );
});

test("only the first line reaches the page; the stack stays in the log", () => {
  const e = serverError('column "x" does not exist\n    at Parser.parseErrorMessage\n    at Socket.emit');
  assert.equal(readErrorDetail(e), 'column "x" does not exist');
});

test("a failure that is not an Error still produces a sentence", () => {
  assert.equal(readErrorDetail("connection terminated"), "connection terminated");
  assert.equal(readErrorDetail(new Error("")), "the read failed without saying why");
  assert.equal(readErrorDetail(null), "null");
});

// The read-only guard firing is a defect in our own SQL. It has no SQLSTATE, so
// it takes the plain path — and must still be readable.
test("a read-only violation is reported in words an operator can act on", () => {
  let caught: unknown;
  try { assertReadOnly("DELETE FROM users"); } catch (e) { caught = e; }
  assert.match(readErrorMessage(caught, "stages", "deploy_stages"), /must be read-only; found "DELETE"/i);
});

// EPIPE and EPERM are five uppercase characters, exactly like a SQLSTATE. An
// earlier version matched the code by shape and quoted broken pipes verbatim —
// address, port and all — down the path meant for safe server diagnostics.
test("a Node error code shaped like a SQLSTATE is still a connection error", () => {
  for (const code of ["EPIPE", "EPERM"]) {
    const e = connectionError("write EPIPE to 10.0.0.5:5432", code);
    assert.equal(readErrorDetail(e), `could not reach the database (${code})`);
  }
});

test("what separates the two paths is severity, not the shape of the code", () => {
  // Same five-character code; only the severity differs.
  const fromServer = Object.assign(new Error("boom at 10.0.0.5:5432"), { code: "XX000", severity: "ERROR" });
  const fromDriver = Object.assign(new Error("boom at 10.0.0.5:5432"), { code: "XX000" });
  assert.match(readErrorDetail(fromServer), /boom at/);
  assert.equal(readErrorDetail(fromDriver), "could not reach the database (XX000)");
  // Either way the address never survives.
  assert.ok(!readErrorDetail(fromServer).includes("10.0.0.5"));
  assert.ok(!readErrorDetail(fromDriver).includes("10.0.0.5"));
});

// ─── identities must not escape ───────────────────────────────────────────────

// The page now renders user emails. An error message and a log line are both
// ways for one to leave the page it was gated behind.
test("an email is redacted wherever it appears in an error", () => {
  assert.equal(redact('duplicate key value: (email)=(ada@example.com)'), "duplicate key value: (email)=([email redacted])");
  assert.equal(redact("invalid input for ilmak1704@gmail.com"), "invalid input for [email redacted]");
  // Plus-addressing, subdomains and the odder legal local parts.
  assert.equal(redact("a.b+tag@mail.co.uk failed"), "[email redacted] failed");
  assert.equal(redact("weird!name@sub.domain.example failed"), "[email redacted] failed");
});

test("several emails in one message are all redacted", () => {
  assert.equal(
    redact("a@x.com and b@y.com conflict"),
    "[email redacted] and [email redacted] conflict",
  );
});

test("an email survives neither path out of a failed read", () => {
  const e = Object.assign(new Error('key (email)=(ada@example.com) already exists'), { code: "23505", severity: "ERROR" });
  const rendered = readErrorMessage(e, "users", "users");
  assert.ok(!rendered.includes("ada@example.com"), "the rendered panel must not carry it");
  assert.ok(!rendered.includes("@example.com"), "nor the domain");
  assert.match(rendered, /\[email redacted\]/);
});

// The column is called "email"; talking about it is not leaking one.
test("redaction does not mangle a message that merely mentions the column", () => {
  assert.equal(redact('column "email" does not exist'), 'column "email" does not exist');
  assert.equal(redact("null value in column email violates not-null constraint"), "null value in column email violates not-null constraint");
});

// A connection string carries a credential AND an @; the whole thing has to go,
// not just the part after the @.
test("a connection string is taken whole rather than half-redacted", () => {
  const out = redact("postgres://admin:hunter2@db.internal:5432/app");
  assert.equal(out, "[connection string redacted]");
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("admin"));
});
