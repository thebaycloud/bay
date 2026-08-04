import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `markAppLive`, against a recorded pool.
 *
 * lib/apps.ts had no test at all, which is how the seam this file exists to
 * cover stayed invisible: the UPDATE naming a column and the migration creating
 * it are in two different languages, in two directories, verified by nothing.
 * TypeScript cannot check a string against a .sql file, so a rename on one side
 * lands green and fails at go-live — which is the single worst moment in a
 * deploy to fail, because the build already worked and the failure discards it.
 */

interface Recorded { sql: string; params: unknown[] }
let queries: Recorded[] = [];
/** Errors to throw for the Nth query, so the fallback path is reachable. */
let failWith: (Error | null)[] = [];

mock.module("../lib/db", {
  namedExports: {
    getPool: () => ({
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        const e = failWith[queries.length - 1];
        if (e) throw e;
        return { rows: [], rowCount: 0 };
      },
    }),
    dbNameForSlug: (s: string) => s,
  },
});

/**
 * Loaded after the mock is installed, and lazily: a top-level await does not
 * survive this suite's transform, and importing at the top would bind the real
 * `getPool` and open a socket to production Postgres from a unit test.
 */
let loaded: Promise<typeof import("../lib/apps")> | null = null;
const markAppLive = async (...a: Parameters<typeof import("../lib/apps")["markAppLive"]>) =>
  (await (loaded ??= import("../lib/apps"))).markAppLive(...a);

function reset() {
  queries = [];
  failWith = [];
}

/** The column the migration actually creates, read from the migration. */
function migratedColumn(): { column: string; table: string } {
  const sql = readFileSync(join(import.meta.dirname, "..", "db", "015_app_has_web.sql"), "utf8");
  const m = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/i.exec(sql);
  assert.ok(m, "015_app_has_web.sql must add a column with ALTER TABLE ... ADD COLUMN IF NOT EXISTS");
  return { table: m[1], column: m[2] };
}

test("the column markAppLive writes is the column the migration creates", async () => {
  reset();
  // Not a hard-coded "has_web" on both sides — the expected name is READ OUT of
  // the migration file. Rename it there and leave the UPDATE alone (or the
  // reverse) and this fails, which is the only way that mistake can be caught:
  // the .sql file is not typechecked and no import connects the two.
  const { column, table } = migratedColumn();

  await markAppLive("demo", "https://demo.example", null, null, false);

  assert.equal(queries.length, 1, "one UPDATE, no fallback, when the column exists");
  const sql = queries[0].sql;
  assert.match(sql, new RegExp(`\\b${column}\\b`), `the UPDATE must write ${column}; it was: ${sql}`);
  assert.match(sql, new RegExp(`UPDATE\\s+${table}\\b`, "i"), `the UPDATE must target ${table}`);
  // The value has to actually be bound, not just the column named.
  assert.ok(queries[0].params.includes(false), `false must reach the query; params were ${JSON.stringify(queries[0].params)}`);
});

test("omitting hasWeb leaves the stored value alone rather than claiming a web process", async () => {
  reset();
  const { column } = migratedColumn();
  // A caller that says nothing must not overwrite. Writing `true` by default
  // would take a worker-only app that was correctly marked and put it straight
  // back to answering "This deploy stopped" on its own URL.
  await markAppLive("demo", "https://demo.example");
  assert.match(queries[0].sql, new RegExp(`${column}\\s*=\\s*COALESCE`, "i"),
    `an omitted hasWeb must COALESCE onto the stored value; SQL was: ${queries[0].sql}`);
  assert.ok(queries[0].params.includes(null), "the omitted value must bind as null, which is what COALESCE falls through");
});

test("a control plane running ahead of the migration still marks the app live", async () => {
  reset();
  // THIS IS THE ONE THAT FAILED BEFORE THE FIX. The existing guard matched only
  // /column .*routes.* does not exist/, and Postgres names the missing column in
  // the message — so adding has_web to the UPDATE made this error rethrow, and
  // every deploy in the platform would have failed at the moment it went live,
  // after the build had already succeeded.
  failWith = [Object.assign(new Error(`column "has_web" of relation "apps" does not exist`), { code: "42703" })];

  await assert.doesNotReject(
    markAppLive("demo", "https://demo.example", null, null, false),
    "a missing has_web column must fall back, not discard a build that worked",
  );
  assert.equal(queries.length, 2, "the fallback must issue a second UPDATE");
  assert.doesNotMatch(queries[1].sql, /has_web/, "the fallback must drop the column it just learned is absent");
  assert.match(queries[1].sql, /status = 'live'/, "the fallback must still mark the app live");
});

test("the routes fallback it already had is not broken by the new alternation", async () => {
  reset();
  // The pattern was widened, not replaced. The case it was written for has to
  // keep working, or this change trades one go-live failure for another.
  failWith = [new Error(`column "routes" of relation "apps" does not exist`)];
  await assert.doesNotReject(markAppLive("demo", "https://demo.example", null, [{ path: "/api", url: "u" }], true));
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1].sql, /routes/, "the fallback must drop routes");
});

test("an error that is not a missing column is still thrown", async () => {
  reset();
  // The fallback is narrow on purpose. Swallowing a connection failure here
  // would mark nothing live and report success — a deploy that says it shipped
  // and did not.
  failWith = [new Error("connection terminated unexpectedly")];
  await assert.rejects(markAppLive("demo", "https://demo.example", null, null, true), /connection terminated/);
  assert.equal(queries.length, 1, "no fallback for an error that is not about a missing column");
});
