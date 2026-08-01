import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { splitStatements, isNoTransaction, NO_TRANSACTION_DIRECTIVE } from "../lib/sql-statements";

const dbDir = new URL("../db/", import.meta.url);
const readMigration = (f: string) => readFileSync(new URL(f, dbDir), "utf8");

test("statements are split on their semicolons", () => {
  assert.deepEqual(splitStatements("SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(splitStatements("SELECT 1;\nSELECT 2;\n"), ["SELECT 1", "SELECT 2"]);
});

test("a file of comments and whitespace holds no statements", () => {
  assert.deepEqual(splitStatements(""), []);
  assert.deepEqual(splitStatements("   \n\n  "), []);
  assert.deepEqual(splitStatements("-- just a note\n-- and another\n"), []);
  assert.deepEqual(splitStatements("/* block */\n;;;\n"), []);
});

// Splitting SQL on semicolons is a classic way to break a migration. Each of
// these would produce a fragment that fails or, worse, one that runs and means
// something else.
test("a semicolon inside a string literal does not split anything", () => {
  assert.deepEqual(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1"), [
    "INSERT INTO t VALUES ('a;b')",
    "SELECT 1",
  ]);
});

test("an escaped quote does not end the string", () => {
  assert.deepEqual(splitStatements("SELECT 'it''s; fine'; SELECT 2"), ["SELECT 'it''s; fine'", "SELECT 2"]);
});

test("a semicolon inside a quoted identifier does not split anything", () => {
  assert.deepEqual(splitStatements('CREATE TABLE "odd;name" (a int); SELECT 1'), [
    'CREATE TABLE "odd;name" (a int)',
    "SELECT 1",
  ]);
});

test("a semicolon inside a comment does not split anything", () => {
  assert.deepEqual(splitStatements("SELECT 1 -- a; comment\n; SELECT 2"), ["SELECT 1 -- a; comment", "SELECT 2"]);
  assert.deepEqual(splitStatements("SELECT 1 /* a; comment */; SELECT 2"), ["SELECT 1 /* a; comment */", "SELECT 2"]);
});

test("block comments nest, as they do in Postgres", () => {
  assert.deepEqual(splitStatements("SELECT 1 /* outer /* inner; */ still; */; SELECT 2"), [
    "SELECT 1 /* outer /* inner; */ still; */",
    "SELECT 2",
  ]);
});

test("a dollar-quoted body is one statement, semicolons and all", () => {
  const sql = "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$; SELECT 1";
  assert.deepEqual(splitStatements(sql), ["DO $$ BEGIN PERFORM 1; PERFORM 2; END $$", "SELECT 1"]);
});

test("a tagged dollar quote is respected, and an inner $$ does not close it", () => {
  const sql = "DO $body$ SELECT '$$'; SELECT 2; $body$; SELECT 3";
  assert.deepEqual(splitStatements(sql), ["DO $body$ SELECT '$$'; SELECT 2; $body$", "SELECT 3"]);
});

test("a bare dollar sign is not a dollar quote", () => {
  assert.deepEqual(splitStatements("SELECT cost$ FROM t; SELECT 2"), ["SELECT cost$ FROM t", "SELECT 2"]);
});

// The real thing this has to survive: 002 wraps an INSERT in a DO $$ … END $$
// block containing several semicolons.
test("the DO block in 002_allowlist.sql survives being split", () => {
  const statements = splitStatements(readMigration("002_allowlist.sql"));
  const doBlocks = statements.filter((s) => s.includes("DO $$"));
  assert.equal(doBlocks.length, 1, "the DO block must be exactly one statement");
  assert.ok(doBlocks[0].includes("END $$"), "the DO block must be whole");
  assert.ok(doBlocks[0].includes("ON CONFLICT (email) DO NOTHING"), "its body must be intact");
});

/** Comments and whitespace removed — the executable SQL and nothing else. */
function bareSql(s: string): string {
  return s
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s;]+$/g, "")
    .trim();
}

// Every migration is currently applied as one batch. Splitting must therefore
// preserve the SQL of all of them, whether or not they opt in — otherwise the
// splitter is a trap for whoever adds the directive next.
//
// Compared on the SQL rather than the raw text, because dropping a trailing
// comment is correct: a comment after the last semicolon is not a statement and
// must not be sent as one.
test("every migration in the repo keeps its SQL through the splitter", () => {
  const files = readdirSync(dbDir).filter((f) => /^\d+_.*\.sql$/.test(f));
  assert.ok(files.length >= 10, `expected the migrations, found ${files.length}`);
  for (const file of files) {
    const sql = readMigration(file);
    const rejoined = splitStatements(sql).join(";\n");
    assert.equal(bareSql(rejoined), bareSql(sql), `${file} lost or gained SQL`);
  }
});

test("only the file that asks for it is applied outside a transaction", () => {
  assert.equal(isNoTransaction(readMigration("010_analytics_indexes.sql")), true);
  for (const file of ["000_base.sql", "002_allowlist.sql", "008_service_routes.sql", "009_admins.sql"]) {
    assert.equal(isNoTransaction(readMigration(file)), false, `${file} must keep its transaction`);
  }
});

test("the directive is recognised anywhere in the file's leading comments", () => {
  assert.equal(isNoTransaction(`-- a heading\n${NO_TRANSACTION_DIRECTIVE}\nCREATE INDEX ...`), true);
  assert.equal(isNoTransaction("-- MIGRATE: NO-TRANSACTION\n"), true);
  // But not when it is merely mentioned in prose, which is how a file that
  // explains the mechanism would otherwise opt itself in by accident.
  assert.equal(isNoTransaction("-- see the -- migrate: no-transaction directive in 010\n"), false);
});

// The whole point of the exercise: this must reach Postgres as ONE statement,
// because CREATE INDEX CONCURRENTLY cannot run inside a transaction block and a
// multi-statement simple query is one.
test("the concurrent index is a single statement that keeps CONCURRENTLY", () => {
  const statements = splitStatements(readMigration("010_analytics_indexes.sql"));
  assert.equal(statements.length, 1);
  assert.match(statements[0], /CREATE INDEX CONCURRENTLY IF NOT EXISTS deploy_stages_started_at_idx/);
  // Semicolons inside the leading comments are fine — Postgres's lexer discards
  // comments, so they create no second statement. What must not appear is a
  // semicolon in the SQL itself.
  assert.ok(!bareSql(statements[0]).includes(";"), "the executable SQL must be one statement");
});

/**
 * Known exceptions, each one deliberate.
 *
 * `006` drops the email-only unique constraint and creates its (email, provider)
 * replacement in the same transaction. Making that index CONCURRENTLY would
 * force the two apart, leaving a window in which nothing enforces uniqueness on
 * the key accounts are identified by — and a CONCURRENTLY unique build that
 * fails leaves an INVALID index, which would make that window permanent. The
 * lock is the cheaper risk here. It has also long since been applied, so
 * re-running it builds nothing.
 */
const PLAIN_INDEX_ALLOWED = new Map([
  ["006_account_per_provider.sql", "unique index must be atomic with the constraint it replaces"],
]);

/**
 * The defect this change exists to fix.
 *
 * A plain CREATE INDEX holds a SHARE lock for the whole build, blocking every
 * write to the table. That is only safe when the table was created in the same
 * migration — nothing else can be writing to a table that did not exist a
 * statement ago. 001 and 004 index tables they create, which is why they are
 * fine and are left alone; adding an index to a table that already carries
 * production traffic is what has to be CONCURRENTLY.
 */
test("an index on a pre-existing table is always built CONCURRENTLY", () => {
  const files = readdirSync(dbDir).filter((f) => /^\d+_.*\.sql$/.test(f));
  let checked = 0;
  for (const file of files) {
    const statements = splitStatements(readMigration(file)).map(bareSql);
    const createdHere = new Set(
      statements
        .map((s) => /^CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z0-9_]*)/i.exec(s)?.[1]?.toLowerCase())
        .filter((t): t is string => !!t),
    );
    for (const s of statements) {
      const m = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?:\s+CONCURRENTLY)?(?:\s+IF NOT EXISTS)?\s+\S+\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(s);
      if (!m) continue;
      checked++;
      if (createdHere.has(m[1].toLowerCase())) continue;
      if (PLAIN_INDEX_ALLOWED.has(file)) continue;
      assert.match(
        s,
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i,
        `${file} indexes pre-existing table "${m[1]}" without CONCURRENTLY, which blocks writes to it for the whole build`,
      );
    }
  }
  assert.ok(checked >= 5, `expected to have checked the repo's indexes, checked ${checked}`);
});
