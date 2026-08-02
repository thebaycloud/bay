import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnvelope, track, unconsumed, assertAllConsumed, assertReached, UnconsumedField } from "../lib/envelope";
import { DEFAULT_SCALE } from "../lib/lanes";
import type { ResolvedApp, ResolvedService } from "../lib/resolve";

const app = { source: "config", resources: {}, services: [] } as unknown as ResolvedApp;

function service(over: Partial<ResolvedService> = {}): ResolvedService {
  return {
    name: "api", dir: ".", path: "/", lane: "runner",
    spaFallback: false, uses: [], env: {}, buildEnv: {}, secrets: [], envNeeded: [],
    health: { path: "/", expect: 200 }, scale: DEFAULT_SCALE,
    ...over,
    declared: (over.declared ?? Object.keys(over).filter((k) => k !== "declared")) as ResolvedService["declared"],
  } as ResolvedService;
}

/**
 * The bug this module exists for: `env` was listed in LANE_CONSUMES for every
 * lane, refused if it collided with a platform name, printed back by
 * `supersonic check` — and read by no code at all. Every static check passed.
 * A capability list is a second declaration, not an observation.
 */

test("a declared field the lane never reads fails the deploy, naming it", () => {
  const original = buildEnvelope(service({ env: { LOG_LEVEL: "info" } }), app);
  const { envelope, readFields } = track(original);
  // A lane that reads everything except env — exactly the umami failure.
  void envelope.install; void envelope.start; void envelope.secrets;
  assert.throws(() => assertAllConsumed(original, readFields()), (e: Error) => {
    assert.ok(e instanceof UnconsumedField);
    assert.match(e.message, /never read: env/);
    assert.match(e.message, /platform bug, not a mistake in your configuration/);
    return true;
  });
});

test("a lane that reads the field passes", () => {
  const original = buildEnvelope(service({ env: { LOG_LEVEL: "info" } }), app);
  const { envelope, readFields } = track(original);
  void envelope.env;
  assert.doesNotThrow(() => assertAllConsumed(original, readFields()));
});

test("a field the author left empty is not required to be read", () => {
  // Every service carries every field. Only what somebody wrote is a promise.
  const original = buildEnvelope(service(), app);
  const { readFields } = track(original);
  assert.deepEqual(unconsumed(original, readFields()), []);
});

test("identity fields are never asserted, because reading them proves nothing", () => {
  const original = buildEnvelope(service({ release: "alembic upgrade head" }), app);
  const { readFields } = track(original);
  const missed = unconsumed(original, readFields());
  assert.ok(!missed.includes("name"));
  assert.ok(!missed.includes("lane"));
  assert.ok(missed.includes("release"));
});

test("authorship comes from the resolver, never from whether a value looks empty", () => {
  // `health` and `scale` hold resolver defaults on EVERY service, so "is it
  // non-empty" answers yes for a service whose author wrote nothing — and the
  // deploy would fail demanding a lane read a default nobody asked for. The
  // envelope trusts the resolver's record of what was written and re-derives
  // nothing: values present, declared empty, so nothing is owed.
  const original = buildEnvelope(service({
    install: "npm ci", env: { A: "1" }, declared: [],
  }), app);
  assert.deepEqual(unconsumed(original, new Set()), []);
});

test("each kind of non-empty is demanded", () => {
  const original = buildEnvelope(service({
    install: "npm ci", secrets: ["K"], env: { A: "1" }, spaFallback: true, uses: ["database"],
  }), app);
  const missed = unconsumed(original, new Set());
  for (const f of ["install", "secrets", "env", "spaFallback", "uses"]) {
    assert.ok(missed.includes(f), `${f} was declared and not demanded`);
  }
});

test("the check reads the original, not the proxy, or it would pass unconditionally", () => {
  // Inspecting the tracked envelope to discover what was declared would mark
  // every field read — a very quiet way to delete the safety net.
  const original = buildEnvelope(service({ release: "migrate" }), app);
  const { envelope, readFields } = track(original);
  assert.throws(() => assertAllConsumed(envelope, readFields()), UnconsumedField);
  const after = track(original);
  assert.deepEqual(unconsumed(original, after.readFields()), ["release"]);
});

test("the tracked envelope still behaves exactly like the envelope", () => {
  const original = buildEnvelope(service({ install: "npm ci", scale: DEFAULT_SCALE }), app);
  const { envelope } = track(original);
  assert.equal(envelope.install, "npm ci");
  assert.equal(envelope.scale.memory, DEFAULT_SCALE.memory);
  assert.equal(envelope.lane, "runner");
});

test("reads are recorded once per field, however often they happen", () => {
  const original = buildEnvelope(service({ install: "npm ci" }), app);
  const { envelope, readFields } = track(original);
  void envelope.install; void envelope.install; void envelope.install;
  assert.ok(readFields().has("install"));
});

test("several ignored fields are reported together, not one deploy at a time", () => {
  const original = buildEnvelope(service({
    env: { A: "1" }, buildEnv: { B: "2" }, release: "migrate",
  }), app);
  assert.throws(() => assertAllConsumed(original, new Set()), (e: Error) => {
    assert.match(e.message, /buildEnv, env, release/);
    return true;
  });
});

/* ── the outcome check: did the value actually reach the revision ────────── */

const outcome = (over: Partial<import("../lib/envelope").DeployOutcome> = {}) => ({
  revisionEnv: [], hasRevision: true, releaseCommand: "", argv: [], hasDatabase: false, ...over,
});

test("env declared but set on nothing fails the deploy", () => {
  // Exactly the umami failure: parsed, validated, printed back by `check`,
  // declared consumable by every lane in LANE_CONSUMES — and absent from the
  // revision. Every static assertion passed.
  const e = buildEnvelope(service({ env: { LOG_LEVEL: "info" }, declared: ["env"] }), app);
  assert.throws(() => assertReached(e, outcome()), /did not apply: env/);
  assert.doesNotThrow(() => assertReached(e, outcome({ revisionEnv: [{ name: "LOG_LEVEL", fromSecret: false }] })));
});

test("a release command that no lane would run fails the deploy", () => {
  // `language: "other"` took the container branch, which set no release command
  // at all, and the deploy went straight from "Plan ready" to "Deploying".
  const e = buildEnvelope(service({ release: "prisma migrate deploy", declared: ["release"] }), app);
  assert.throws(() => assertReached(e, outcome()), /did not apply: release/);
  assert.doesNotThrow(() => assertReached(e, outcome({ releaseCommand: "prisma migrate deploy" })));
});

test("uses: [database] with no database provisioned fails the deploy", () => {
  const e = buildEnvelope(service({ uses: ["database"], declared: ["uses"] }), app);
  assert.throws(() => assertReached(e, outcome()), /did not apply: uses/);
  assert.doesNotThrow(() => assertReached(e, outcome({ hasDatabase: true })));
});

test("uses: [database] on an external database is proved by the secret, not by provisioning", () => {
  // The same declaration means two different observable things depending on whose
  // database it is, and checking only the platform's half would let the new mode
  // become the next field that is declared, valid, and acted on by nobody —
  // which is the failure this module was written for.
  const external = {
    source: "config",
    resources: { database: { provider: "external", urlFrom: "DATABASE_URL" } },
    services: [],
  } as unknown as ResolvedApp;
  const e = buildEnvelope(service({ uses: ["database"], declared: ["uses"] }), external);

  // Provisioning did not run, and must not be what this asks about.
  assert.throws(() => assertReached(e, outcome({ hasDatabase: false })), /did not apply: uses/);
  assert.doesNotThrow(() =>
    assertReached(e, outcome({ revisionEnv: [{ name: "DATABASE_URL", fromSecret: true }] })));
});

test("an external database URL arriving as a plain variable does not count", () => {
  // A credential written verbatim into the revision spec has reached the app and
  // defeated the reason for it being a secret — the same distinction `secrets`
  // already turns on.
  const external = {
    source: "config",
    resources: { database: { provider: "external", urlFrom: "DATABASE_URL" } },
    services: [],
  } as unknown as ResolvedApp;
  const e = buildEnvelope(service({ uses: ["database"], declared: ["uses"] }), external);
  assert.throws(
    () => assertReached(e, outcome({ revisionEnv: [{ name: "DATABASE_URL", fromSecret: false }] })),
    /did not apply: uses/,
  );
});

test("a declared secret that never got mounted fails the deploy", () => {
  const e = buildEnvelope(service({ secrets: ["STRIPE_KEY"], declared: ["secrets"] }), app);
  assert.throws(() => assertReached(e, outcome()), /did not apply: secrets/);
  assert.doesNotThrow(() => assertReached(e, outcome({ revisionEnv: [{ name: "STRIPE_KEY", fromSecret: true }] })));
});

test("a declared scale that never reached the argv fails the deploy", () => {
  const scale = { ...DEFAULT_SCALE, memory: "4Gi", timeout: 1200 };
  const e = buildEnvelope(service({ scale, declared: ["scale"] }), app);
  assert.throws(() => assertReached(e, outcome()), /did not apply: scale/);
  assert.doesNotThrow(() => assertReached(e, outcome({ argv: ["--memory", "4Gi", "--timeout=1200"] })));
});

test("a new schema field with no known effect fails loudly rather than passing", () => {
  // The list of effects can drift like any list. It drifts LOUDLY: adding a
  // field without teaching this what it does stops the first deploy declaring
  // it, instead of shipping another value that quietly does nothing.
  const e = buildEnvelope(service({ declared: ["somethingNew" as never] }), app);
  assert.throws(() => assertReached(e, outcome()), /nothing knows what this field's effect looks like/);
});

test("what nobody declared is never demanded", () => {
  const e = buildEnvelope(service({ env: { A: "1" }, declared: [] }), app);
  assert.doesNotThrow(() => assertReached(e, outcome()));
});

test("a secret inherited from an earlier deploy is not a failure", () => {
  // The first run of this check failed a working app for exactly this. Both
  // --update-secrets and --update-env-vars MERGE, deliberately, so a redeploy
  // cannot drop a key an earlier one set — and the app's SECRET_KEY had one
  // Secret Manager version, from a deploy an hour earlier. It was live, correct,
  // and never re-sent. What matters is what the revision carries.
  const e = buildEnvelope(service({ secrets: ["SECRET_KEY"], declared: ["secrets"] }), app);
  assert.doesNotThrow(() => assertReached(e, outcome({
    revisionEnv: [{ name: "SECRET_KEY", fromSecret: true }],
  })));
});

test("a secret that arrived as a plain value still fails", () => {
  // Reaching the app is not enough for this field: a secret in the revision spec
  // as a literal is readable by anyone with `run services describe` and is the
  // thing declaring it a secret was supposed to prevent.
  const e = buildEnvelope(service({ secrets: ["SECRET_KEY"], declared: ["secrets"] }), app);
  assert.throws(() => assertReached(e, outcome({
    revisionEnv: [{ name: "SECRET_KEY", fromSecret: false }],
  })), /did not apply: secrets/);
});

test("a lane with no revision to read cannot fail on the environment", () => {
  // The static lane deploys no Cloud Run service. Unverifiable is not failed.
  const e = buildEnvelope(service({ lane: "static", env: { A: "1" }, declared: ["env"] }), app);
  assert.doesNotThrow(() => assertReached(e, outcome({ hasRevision: false })));
});
