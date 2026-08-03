import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_BUCKET, backupObject, expired, exportArgs, importArgs, importSucceeded, slugOfBackup, sortNewestFirst } from "../lib/backups";

test("a dump never lands in the bucket the static server publishes from", () => {
  // `supersonic-static-assets` is what the shared static server serves. A SQL dump
  // containing every row of a customer's database, placed there, is one routing
  // mistake away from being downloadable.
  assert.equal(BACKUP_BUCKET, "supersonic-db-backups");
  assert.notEqual(BACKUP_BUCKET, "supersonic-static-assets");
  for (const argv of [exportArgs("demo", "backups/demo/x.sql.gz"), importArgs("demo", "backups/demo/x.sql.gz")]) {
    assert.ok(!argv.join(" ").includes("static-assets"));
  }
});

test("object names sort by time, because that is how they will be read", () => {
  const a = backupObject("demo", new Date("2026-08-01T08:00:00.000Z"));
  const b = backupObject("demo", new Date("2026-08-03T08:00:00.000Z"));
  assert.ok(a < b, "lexicographic order must equal chronological order");
  assert.deepEqual(sortNewestFirst([a, b]), [b, a]);
  // No colons: legal in GCS, awkward in every shell that will handle one.
  assert.ok(!a.includes(":"));
  assert.equal(slugOfBackup(a), "demo");
  assert.equal(slugOfBackup("something/else.sql.gz"), null);
});

test("one app's backup names another app's database in no way at all", () => {
  // The whole reason these exist beside the instance's own backups: a Cloud SQL
  // restore restores the INSTANCE, and every app shares one — so rolling app A
  // back to yesterday would roll B through Z back with it.
  const argv = exportArgs("demo-api", "backups/demo-api/x.sql.gz");
  assert.ok(argv.includes("--database"));
  assert.equal(argv[argv.indexOf("--database") + 1], "demo_api", "hyphens are not legal in a Postgres database name");
  assert.ok(argv.join(" ").includes("gs://supersonic-db-backups/backups/demo-api/"));
});

test("retention is bounded by count as well as by age", () => {
  // The bucket's lifecycle rule expires objects at 30 days, which bounds cost and
  // not count: an app deployed hourly holds 700 dumps inside that window.
  const objects = Array.from({ length: 20 }, (_, i) =>
    backupObject("demo", new Date(Date.UTC(2026, 7, 1, i))));
  const dead = expired(objects, 14);
  assert.equal(dead.length, 6);
  // The six OLDEST, never the six newest.
  assert.ok(dead.every((d) => d < sortNewestFirst(objects)[13]));
  assert.deepEqual(expired(objects.slice(0, 3), 14), [], "fewer than the limit expires nothing");
});

test("a restore that worked is not reported as failed over a privilege statement", () => {
  // Measured against the real instance: export an app's database, import it into a
  // scratch one, and Cloud SQL returns `exit status 3` with
  // `ERROR: permission denied to change default privileges` — while the SAME
  // output contains `CREATE TABLE` and `COPY 9`. The data is there. The failing
  // statement governs privileges on objects created LATER and has nothing to do
  // with the rows.
  //
  // Trusting the exit code would tell somebody their restore failed while their
  // data sat there restored, and they would go looking for another backup or give
  // up. That is the more expensive direction to be wrong in.
  const real = "SET\nSET\nCREATE TABLE\nCOPY 9\nERROR:  permission denied to change default privileges\n";
  assert.equal(importSucceeded(3, real), true);
  assert.equal(importSucceeded(0, "SET\n"), true);

  // A real failure is still a failure.
  assert.equal(importSucceeded(1, 'ERROR:  relation "users" already exists\n'), false);
  assert.equal(importSucceeded(1, "ERROR:  syntax error at or near\n"), false);
  // Privilege noise with nothing restored is not a success either.
  assert.equal(importSucceeded(3, "ERROR:  permission denied to change default privileges\n"), false);
});
