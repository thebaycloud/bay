import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A pooled connection outliving the database it points at.
 *
 * Found by running the real drop against production on 16 Aug, not by a test —
 * which is the point of writing one now. The sequence:
 *
 *   1. a deploy calls `ensureAppRole`, which opens a pool on the app's database
 *      and leaves it in the module-level map, as every pool here is left;
 *   2. a delete calls `dropAppDatabase`, which must run `pg_terminate_backend`
 *      over that database because `DROP DATABASE` refuses while any session is
 *      connected;
 *   3. the terminated session is this process's own idle client. Nothing is
 *      awaiting it, so `pg` raises 'error' on the pool — and an 'error' event
 *      with no listener ends the Node process.
 *
 * The database was already gone by then, so the crash came AFTER the work
 * succeeded: the caller saw a stack trace for an operation that had worked.
 *
 * Asserted by reading the source rather than by opening a Postgres, because what
 * is being pinned is that two lines EXIST — a listener and a disposal — and both
 * are invisible in behaviour until the rare moment they are not.
 */

const db = readFileSync(join(process.cwd(), "lib/db.ts"), "utf8");
const pgRole = readFileSync(join(process.cwd(), "lib/pg-role.ts"), "utf8");

test("every pool has an error listener, because an idle client can die at any time", () => {
  // Not only the drop. Cloud SQL runs maintenance every few months and severs
  // every idle connection on the instance; enabling PITR on 16 Aug restarted
  // both instances for the same reason. Without this listener each of those is
  // an unhandled 'error' event in the control plane.
  assert.match(db, /pool\.on\("error"/,
    "a pool with no 'error' listener turns a severed idle connection into a process exit");
  // On the shared constructor, so it cannot be added to one pool and missed on
  // the other — the two-instance split doubled how many kinds there are.
  const constructors = db.match(/new Pool\(/g) ?? [];
  const listeners = db.match(/pool\.on\("error"/g) ?? [];
  assert.ok(listeners.length >= 1 && constructors.length >= 1);
  assert.ok(
    db.indexOf('pool.on("error"') > db.lastIndexOf("new Pool("),
    "the listener must attach after construction, in the one place pools are made",
  );
});

test("the drop forgets its pool before it terminates anything", () => {
  // Order is the behaviour. Forgetting AFTER the terminate is forgetting a pool
  // whose client has already raised — the crash has happened by then.
  const forget = pgRole.indexOf("forgetTenantPool(dbName)");
  const connect = pgRole.indexOf("getTenantPool(NEUTRAL_DB_FOR_DROP)");
  assert.ok(forget >= 0, "the drop must dispose of its own connections to the target");
  assert.ok(connect >= 0);
  assert.ok(forget < connect, "dispose first, then open the session that does the dropping");
});

test("forgetting a pool removes it from the map, not just its connections", () => {
  // The slug space is five characters and `resolveSlug` reissues freed names, so
  // a pool left in the map under a dropped database's key is a pool a LATER app
  // of the same name would be handed. `end()` alone leaves that entry behind.
  assert.match(db, /pools\.delete\(key\)/,
    "a dropped database's pool must leave the map, or a reused slug inherits it");
});
