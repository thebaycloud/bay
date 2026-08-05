import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";

/**
 * Who may read an app's secrets, and WHEN the binding is written.
 *
 * `putAppSecrets` granted the runtime identity only on the branch that CREATED
 * a secret, so the grant was a side effect of a secret being new rather than a
 * property of the secret. Every app deployed before a change to
 * APP_RUNTIME_SERVICE_ACCOUNT keeps a binding for the OLD account and never
 * gains one for the new — and nothing says so until the app starts and gets a
 * 403 on a value it has always had.
 *
 * The same defect shape the fleet node had on 5 Aug: a per-deploy binding only
 * covers apps deployed since the binding existed.
 */

type Argv = string[];
let calls: Argv[] = [];
/** Which secret names Secret Manager claims to already hold. */
let existing = new Set<string>();
/** Whether `add-iam-policy-binding` collides, as concurrent deploys make it. */
let failGrant = false;

function fakeSpawn() {
  const real = require("node:child_process").spawn;
  return (cmd: string, args: string[], opts: unknown) => {
    if (cmd !== "gcloud") return real(cmd, args, opts);
    const argv = [cmd, ...(args ?? [])];
    calls.push(argv);

    // `secrets describe <name>` decides which branch putAppSecrets takes.
    let code = 0;
    if (args[0] === "secrets" && args[1] === "describe" && !existing.has(args[2])) code = 1;
    if (failGrant && args[1] === "add-iam-policy-binding") code = 1;

    const p = new EventEmitter() as EventEmitter & Record<string, unknown>;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = { on() {}, end() {} };
    setImmediate(() => {
      if (code !== 0) (p.stderr as EventEmitter).emit("data", Buffer.from("NOT_FOUND"));
      p.emit("close", code);
    });
    return p;
  };
}

let loaded: Promise<typeof import("@/lib/app-secrets")> | null = null;
function load() {
  return (loaded ??= (async () => {
    mock.module("node:child_process", { namedExports: { spawn: fakeSpawn(), execFileSync } });
    return await import("@/lib/app-secrets");
  })());
}

const RUNTIME_SA = "app-runtime@supersonic-deploy-prod.iam.gserviceaccount.com";

function grantsFor(name: string): Argv[] {
  return calls.filter((c) => c[1] === "secrets" && c[2] === "add-iam-policy-binding" && c[3] === name);
}

test("an EXISTING secret still gains the runtime binding", async () => {
  const { putAppSecrets } = await load();
  calls = [];
  failGrant = false;
  // The app has been deployed before, so its secret is already there.
  existing = new Set(["app-p6mx8-DATABASE_URL"]);

  const res = await putAppSecrets("p6mx8", { DATABASE_URL: "postgres://x" }, RUNTIME_SA, () => {});

  assert.deepEqual(res.skipped, [], "nothing should be demoted to a plain env var");
  assert.equal(res.stored.length, 1);

  const grants = grantsFor("app-p6mx8-DATABASE_URL");
  assert.equal(grants.length, 1,
    "a secret that already existed never gained a binding for the runtime account — " +
    "change APP_RUNTIME_SERVICE_ACCOUNT and every app deployed before it 403s");
  assert.ok(grants[0].includes(`serviceAccount:${RUNTIME_SA}`));
  assert.ok(grants[0].includes("roles/secretmanager.secretAccessor"));
});

test("a NEW secret gains the binding exactly once", async () => {
  const { putAppSecrets } = await load();
  calls = [];
  failGrant = false;
  existing = new Set();

  const res = await putAppSecrets("gzz9j", { DATABASE_URL: "postgres://x" }, RUNTIME_SA, () => {});

  assert.deepEqual(res.skipped, []);
  assert.equal(grantsFor("app-gzz9j-DATABASE_URL").length, 1, "granted once, not twice");
  // It was created rather than versioned.
  assert.ok(calls.some((c) => c[1] === "secrets" && c[2] === "create" && c[3] === "app-gzz9j-DATABASE_URL"));
});

test("a grant that fails does not demote the secret to a plain env var", async () => {
  const { putAppSecrets } = await load();
  calls = [];
  existing = new Set(["app-anatf-API_KEY"]);

  // add-iam-policy-binding is a read-modify-write against an etag, so two
  // concurrent deploys of one app can collide on it. The value IS stored;
  // reporting it as skipped would write it into the revision in the clear.
  failGrant = true;
  const logged: string[] = [];

  const res = await putAppSecrets("anatf", { API_KEY: "v" }, RUNTIME_SA, (l) => logged.push(l));
  failGrant = false;

  assert.deepEqual(res.skipped, [], "a failed BINDING must not put the value in the clear");
  assert.equal(res.stored.length, 1, "the secret was stored — that part worked");
  assert.ok(logged.some((l) => /API_KEY/.test(l)), "and the grant failure must be said out loud");
});
