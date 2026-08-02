import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planResources, ordered, destroys, attachedEnv, KINDS,
  ResourceError, type Declared, type Live, type Kind,
} from "../lib/resources";

const nothing: Declared = {
  database: false, externalDatabase: false, bucket: false,
  processes: false, web: false, secrets: [],
};
const fresh: Live = { bucketExists: false, bucketInUse: false, databaseExists: false };

const attached = (d: Declared, live: Live = fresh) =>
  planResources(d, live).attach.map((p) => p.kind);
const released = (d: Declared, live: Live = fresh) =>
  planResources(d, live).release.map((p) => p.kind);

test("a resource nobody asked for is not attached", () => {
  // The live bug this engine exists for: `provisionStorage` runs unconditionally
  // (deploy-pipeline.ts), while `resources.bucket` and `uses: ["bucket"]` are both
  // parsed and read by nothing. Every app is billed for a bucket and told in the
  // dashboard that it has "File uploads".
  assert.ok(!attached(nothing).includes("bucket"));
  assert.ok(!attached(nothing).includes("database"));

  assert.ok(attached({ ...nothing, bucket: true }).includes("bucket"));
});

test("NOTHING that holds customer data is ever deleted by a config edit", () => {
  // The property that makes on-demand safe rather than frightening. A reconciler's
  // value is that it removes what is no longer wanted — and applied naively here,
  // deleting one line from supersonic.json would delete a company's production
  // Postgres. Retention is a property of the KIND, declared once.
  const stateful = ["database", "bucket", "secrets"];
  for (const kind of stateful) {
    const k = KINDS.find((x) => x.kind === kind)!;
    assert.equal(k.retention, "detach", `${kind} must never be destroyed by a deploy`);
  }

  // And the guard a caller has to pass to run anything destructive.
  const { release } = planResources(nothing, { bucketExists: true, bucketInUse: false, databaseExists: true });
  for (const p of release) {
    if (stateful.includes(p.kind)) {
      assert.equal(destroys(p), false, `${p.kind} was marked destructible`);
    }
  }
});

test("an undeclared database is unwired, and its data is kept", () => {
  const live: Live = { ...fresh, databaseExists: true };
  const plan = planResources(nothing, live);

  const db = plan.release.find((p) => p.kind === "database")!;
  assert.equal(db.retention, "detach");
  assert.match(db.reason, /the data is kept/);
  assert.equal(destroys(db), false);
});

test("an undeclared bucket that holds objects stays attached, and says why", () => {
  // Every app deployed before the gate existed was given a bucket whether it asked
  // or not, so "undeclared" cannot be read as "unused". Detaching one that is in
  // use would drop STORAGE_BUCKET from an app that has always had it and is
  // writing to it — a silent behaviour change that breaks working apps.
  const inUse: Live = { ...fresh, bucketExists: true, bucketInUse: true };
  const plan = planResources(nothing, inUse);

  const bucket = plan.attach.find((p) => p.kind === "bucket");
  assert.ok(bucket, "an in-use bucket was detached from an app that is writing to it");
  assert.match(bucket.reason, /uses.*bucket.*to keep it/);

  // An EMPTY undeclared bucket is let go — nothing can break, and the app stops
  // carrying a variable it never asked for.
  const empty: Live = { ...fresh, bucketExists: true, bucketInUse: false };
  assert.ok(released(nothing, empty).includes("bucket"));
});

test("an app that owns its database gets nothing provisioned and no proxy", () => {
  const external: Declared = { ...nothing, database: true, externalDatabase: true };

  assert.ok(!attached(external).includes("database"));
  // The sidecar is the thing that drags in the container-scoped argv, the
  // mandatory startup probe and the one-container-must-declare-a-port rule. An app
  // on Supabase should meet none of it.
  assert.ok(!attached(external).includes("db-proxy"));
});

test("a worker-only app gets no invoker binding and no domain mapping", () => {
  // Both assume an address. A Telegram bot has none, and creating a domain mapping
  // for it would point a hostname at a Cloud Run service that does not exist.
  const bot: Declared = { ...nothing, processes: true };

  assert.ok(attached(bot).includes("processes"));
  assert.ok(!attached(bot).includes("domain"));
  assert.ok(!attached(bot).includes("invoker"));

  const web: Declared = { ...nothing, web: true };
  assert.deepEqual(attached(web).filter((k) => k === "invoker" || k === "domain"), ["invoker", "domain"]);
});

test("ordering is data: a dependency is always attached first", () => {
  const all: Declared = { ...nothing, database: true, bucket: true, processes: true, web: true, secrets: ["K"] };
  const order = attached(all);
  const before = (a: string, b: string) =>
    assert.ok(order.indexOf(a) < order.indexOf(b), `${a} must be attached before ${b}`);

  before("database", "db-proxy");     // nothing to proxy to otherwise
  before("database", "processes");    // a worker connects at start
  before("bucket", "processes");
  before("secrets", "processes");
  before("invoker", "domain");        // the mapping assumes the binding
});

test("release runs in reverse dependency order", () => {
  // Tearing down in creation order leaves a window where something references a
  // thing that has just stopped existing — the proxy pointing at a database, the
  // domain at a binding.
  const order = released(nothing, { bucketExists: true, bucketInUse: false, databaseExists: true });

  assert.ok(order.indexOf("db-proxy") < order.indexOf("database"));
  assert.ok(order.indexOf("domain") < order.indexOf("invoker"));
  assert.ok(order.indexOf("processes") < order.indexOf("database"));
});

test("every kind is either attached or released — nothing is silently skipped", () => {
  // The defect class this whole file is about: a resource with no branch covering
  // it is a resource nobody decides on, which is how `provisionStorage` ended up
  // running unconditionally.
  const cases: Array<[Declared, Live]> = [
    [nothing, fresh],
    [{ ...nothing, database: true, bucket: true, web: true, processes: true, secrets: ["A"] }, fresh],
    [{ ...nothing, externalDatabase: true, database: true }, { ...fresh, databaseExists: true }],
  ];
  for (const [d, live] of cases) {
    const plan = planResources(d, live);
    assert.equal(plan.attach.length + plan.release.length, KINDS.length);
    const seen = new Set([...plan.attach, ...plan.release].map((p) => p.kind));
    assert.equal(seen.size, KINDS.length);
  }
});

test("a dependency on a kind that does not exist is refused, not reordered silently", () => {
  const bad: Kind[] = [
    { kind: "a", retention: "remove", dependsOn: ["typo"], decide: () => ({ attach: true, reason: "" }) },
  ];
  assert.throws(() => ordered(bad), (e: Error) => {
    assert.ok(e instanceof ResourceError);
    assert.match(e.message, /"typo", which is not a resource kind/);
    return true;
  });
});

test("a cycle is refused rather than producing an arbitrary order", () => {
  const cyclic: Kind[] = [
    { kind: "a", retention: "remove", dependsOn: ["b"], decide: () => ({ attach: true, reason: "" }) },
    { kind: "b", retention: "remove", dependsOn: ["a"], decide: () => ({ attach: true, reason: "" }) },
  ];
  assert.throws(() => ordered(cyclic), /form a cycle/);
});

test("a resource contributes ONE canonical variable, not seventeen", () => {
  // `databaseEnv` writes seventeen names — DATABASE_URL, POSTGRES_*, PG*, DB_* —
  // guessed at from what frameworks tend to read, because the branch that
  // provisioned the database also decided what it meant. One name here; anything
  // else the app maps itself.
  assert.deepEqual(attachedEnv("database", { databaseUrl: "postgres://x" }), { DATABASE_URL: "postgres://x" });
  assert.deepEqual(attachedEnv("bucket", { bucket: "b" }), { STORAGE_BUCKET: "b" });

  // And an unattached resource contributes nothing, which is what stops an app
  // carrying STORAGE_BUCKET for a bucket it does not have.
  assert.deepEqual(attachedEnv("bucket", {}), {});
  assert.deepEqual(attachedEnv("processes", { bucket: "b" }), {});
});

test("every reason is specific enough to put in a deploy log", () => {
  // "because the config says so" tells nobody anything. Each decision has to say
  // what it read, because these lines are what an app owner sees when something
  // they expected did not appear.
  for (const [d, live] of [
    [nothing, { bucketExists: true, bucketInUse: true, databaseExists: true }],
    [{ ...nothing, database: true, bucket: true, web: true, processes: true, secrets: ["A"] }, fresh],
  ] as Array<[Declared, Live]>) {
    const plan = planResources(d, live);
    for (const p of [...plan.attach, ...plan.release]) {
      assert.ok(p.reason.length > 3, `${p.kind} has no reason`);
      assert.ok(!/config says/i.test(p.reason), `${p.kind} explains nothing`);
    }
  }
});

test("no destructive gcloud verb can be reached from a detach kind", () => {
  // The property, asserted against reality rather than intent. `destroys` is the
  // one question the imperative half must ask before running anything that
  // deletes, and it is phrased so a caller has to hold a Planned and read its
  // retention rather than remember which kinds are safe.
  //
  // Every combination of declared/live, checked exhaustively: if a stateful kind
  // ever comes back destructible, this fails.
  const bools = [false, true];
  for (const database of bools) for (const externalDatabase of bools)
  for (const bucket of bools) for (const processes of bools) for (const web of bools)
  for (const bucketExists of bools) for (const bucketInUse of bools) for (const databaseExists of bools) {
    const plan = planResources(
      { database, externalDatabase, bucket, processes, web, secrets: [] },
      { bucketExists, bucketInUse, databaseExists },
    );
    for (const p of plan.release) {
      if (["database", "bucket", "secrets"].includes(p.kind)) {
        assert.equal(destroys(p), false, `${p.kind} became destructible`);
      }
    }
  }
});

test("a bucket holding objects is never released, under any declaration", () => {
  // The grandfather rule, exhaustively. Detaching a bucket an app is writing to
  // would drop STORAGE_BUCKET from an app that never declared it and always had
  // it — every app deployed before the gate existed.
  const bools = [false, true];
  for (const database of bools) for (const processes of bools) for (const web of bools) {
    const plan = planResources(
      { database, externalDatabase: false, bucket: false, processes, web, secrets: [] },
      { bucketExists: true, bucketInUse: true, databaseExists: false },
    );
    assert.ok(plan.attach.some((p) => p.kind === "bucket"), "an in-use bucket was released");
  }
});
