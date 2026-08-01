import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertReadOnly, windowOf, ROW_CAP, readErrorMessage } from "../lib/analytics/queries";

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

// A failed read has to say what failed. Postgres already names the defect
// precisely, so the message is passed through rather than replaced with
// something friendlier and useless.
test("the database's own words survive to the page", () => {
  assert.equal(
    readErrorMessage(new Error('column "finished_at" does not exist')),
    'column "finished_at" does not exist',
  );
  assert.equal(
    readErrorMessage(new Error('relation "deploy_events" does not exist')),
    'relation "deploy_events" does not exist',
  );
});

test("only the first line reaches the page; the stack stays in the log", () => {
  const e = new Error('column "x" does not exist\n    at Parser.parseErrorMessage\n    at Socket.emit');
  assert.equal(readErrorMessage(e), 'column "x" does not exist');
});

test("a failure that is not an Error still produces a sentence", () => {
  assert.equal(readErrorMessage("connection terminated"), "connection terminated");
  assert.equal(readErrorMessage(new Error("")), "the read failed without saying why");
  assert.equal(readErrorMessage(null), "null");
});

// The read-only guard firing is a defect in our own SQL. It must reach the page
// as a visible, named failure rather than being swallowed like a missing table.
test("a read-only violation is reported in words an operator can act on", () => {
  let caught: unknown;
  try { assertReadOnly("DELETE FROM users"); } catch (e) { caught = e; }
  assert.match(readErrorMessage(caught), /must be read-only; found "DELETE"/i);
});
