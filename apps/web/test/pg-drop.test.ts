import { test } from "node:test";
import assert from "node:assert/strict";
import { dropStatements, roleNameForSlug } from "../lib/pg-role";

/**
 * Dropping an app's database, as an ORDER of statements.
 *
 * `gcloud sql databases delete` never worked for a provisioned database, and the
 * catch around it is why nobody knew: provisioning makes the app's own role the
 * owner, gcloud connects as cloudsqlsuperuser, and the API answers
 * "must be owner of database". Five customers' databases were still on the
 * shared instance when that was found.
 *
 * Each step below is one the server refuses without the one before it, so the
 * order is the behaviour — not a style choice.
 */

test("ownership is taken before the drop, and membership before ownership", () => {
  const sql = dropStatements("app_icflz", "icflz");

  const grant = sql.findIndex((s) => /^GRANT app_icflz TO CURRENT_USER/.test(s));
  const own = sql.findIndex((s) => /^ALTER DATABASE icflz OWNER TO CURRENT_USER/.test(s));
  const drop = sql.findIndex((s) => /^DROP DATABASE/.test(s));

  assert.ok(grant >= 0, "must take membership of the app's role");
  assert.ok(own >= 0, "must take ownership — this is the step gcloud cannot do");
  assert.ok(drop >= 0, "must drop the database");

  // Cloud SQL's `postgres` is not a real superuser: it cannot take an object
  // from a role it is not a member of. Ownership before membership fails with
  // `must be able to SET ROLE "app_icflz"`, which is the same wall ensureAppRole
  // hit on its first real deploy.
  assert.ok(grant < own, "membership must come before ownership");
  assert.ok(own < drop, "ownership must come before the drop, or it is the old 400 again");
});

test("other sessions are disconnected before the drop", () => {
  const sql = dropStatements("app_icflz", "icflz");
  const kill = sql.findIndex((s) => /pg_terminate_backend/.test(s));
  const drop = sql.findIndex((s) => /^DROP DATABASE/.test(s));

  assert.ok(kill >= 0, "DROP DATABASE fails outright while another session is connected");
  assert.ok(kill < drop, "disconnect first, or the drop reports the database in use");
  // Never the session doing the work.
  assert.match(sql[kill], /pid <> pg_backend_pid\(\)/);
});

test("the role goes too, and last", () => {
  const sql = dropStatements("app_icflz", "icflz");
  const drop = sql.findIndex((s) => /^DROP DATABASE/.test(s));
  const role = sql.findIndex((s) => /^DROP ROLE/.test(s));

  // A live login for an app that no longer exists. The slug space is five
  // characters, so the name WILL be reissued and the new tenant would inherit a
  // stranger's credential.
  assert.ok(role >= 0, "the app's role must be dropped as well");
  // A role cannot be dropped while it still owns something.
  assert.ok(drop < role, "the database must be gone before its owner can be");
});

test("every destructive step tolerates absence", () => {
  const sql = dropStatements("app_icflz", "icflz");
  // Apps that never had a database are the ordinary case; a delete must not
  // fail because there was nothing to delete.
  assert.match(sql.find((s) => /^DROP DATABASE/.test(s))!, /IF EXISTS/);
  assert.match(sql.find((s) => /^DROP ROLE/.test(s))!, /IF EXISTS/);
});

test("the role name matches the one provisioning created", () => {
  // If these two ever disagree, the drop takes ownership of nothing and the
  // database survives with a role nobody can find.
  assert.equal(roleNameForSlug("icflz"), "app_icflz");
  assert.equal(roleNameForSlug("ss-mt-df8y2z"), "app_ss_mt_df8y2z");
  const sql = dropStatements(roleNameForSlug("ss-mt-df8y2z"), "ss_mt_df8y2z");
  assert.ok(sql[0].includes("app_ss_mt_df8y2z"));
});
