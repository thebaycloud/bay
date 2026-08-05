import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The read itself, against a driver that is not a database.
 *
 * `lib/db` is mocked, so this exercises the REAL `readFleetStatus` — the
 * transaction, the statement order, the rollback, the relation the failure is
 * named for, and the shape it returns when a read fails — with no connection to
 * shared production. That is not only about speed: `getPool` points at
 * 127.0.0.1:5433, so a test that "just tried it" would quietly succeed against
 * production on any machine with cloud-sql-proxy running.
 *
 * In its own file because `mock.module` is process-wide within a module graph.
 */

type Handler = (sql: string) => { rows: unknown[] };

/**
 * Module-scoped, because `mock.module` may only be installed ONCE per process —
 * a second call is `ERR_INVALID_STATE: The module is already mocked`. So the
 * mock is installed once and reads whichever handler is current; `withPool`
 * swaps it. The same shape test/deploy-pipeline.test.ts uses, for the same
 * reason.
 */
let handler: Handler = () => ({ rows: [] });
let connectThrows: Error | null = null;
const sent: string[] = [];
const state = { released: 0, connects: 0 };

mock.module("@/lib/db", {
  namedExports: {
    getPool: () => ({
      connect: async () => {
        if (connectThrows) throw connectThrows;
        state.connects++;
        return {
          query: async (sql: string) => {
            sent.push(sql.replace(/\s+/g, " ").trim());
            return handler(sql);
          },
          release: () => {
            state.released++;
          },
        };
      },
    }),
    dbNameForSlug: (s: string) => s,
  },
});

const loaded = import("@/lib/fleet-status");

async function withPool(h: Handler, opts: { connectThrows?: Error } = {}) {
  handler = h;
  connectThrows = opts.connectThrows ?? null;
  sent.length = 0;
  state.released = 0;
  state.connects = 0;
  return (await loaded).readFleetStatus;
}

/** A Postgres server error, as node-pg presents one: it carries `severity`. */
function serverError(message: string) {
  return Object.assign(new Error(message), { severity: "ERROR", code: "42703" });
}

const NOW = new Date("2026-08-05T12:00:00Z");

const goodRows: Handler = (sql) => {
  if (sql.startsWith("SELECT now()")) return { rows: [{ at: NOW }] };
  if (sql.includes("fleet_nodes")) {
    return {
      rows: [
        {
          name: "fleet-lab-1",
          zone: "europe-west2-a",
          internal_ip: "10.0.0.7",
          cpus: "8",
          memory_bytes: "34359738368",
          drain: false,
          last_seen_age_s: "6.5",
        },
      ],
    };
  }
  if (sql.includes("fleet_placements")) {
    return {
      rows: [
        {
          slug: "myapp",
          node: "fleet-lab-1",
          spec: {
            slug: "myapp",
            image: "img",
            port: 8080,
            memoryBytes: 1,
            cpuShares: 1024,
            healthPath: "/",
            env: { DATABASE_URL: "postgres://u:p@h/db" },
            secrets: { DATABASE_URL: "app-myapp-DATABASE_URL" },
            processes: [{ name: "web", kind: "web", command: ["/bin/sh", "-c", "npm start --token=abc"] }],
          },
          placed_age_s: "900",
          runtime: "fleet",
        },
      ],
    };
  }
  if (sql.includes("fleet_process_faults")) {
    return {
      rows: [
        {
          slug: "myapp",
          node: "fleet-lab-1",
          process: "web",
          fault: "node",
          detail: "database path 10.0.0.7 not answering",
          reported_age_s: "7",
        },
      ],
    };
  }
  return { rows: [] };
};

test("the snapshot is read inside one read-only transaction and the client is always returned", async () => {
  const readFleetStatus = await withPool(goodRows);
  const snap = await readFleetStatus();

  assert.equal(snap.ok, true);
  // BEGIN READ ONLY is what actually stops a write against shared production;
  // assertReadOnly only makes the mistake visible earlier.
  assert.equal(sent[0], "BEGIN READ ONLY");
  assert.equal(sent[sent.length - 1], "COMMIT");
  // One clock: `now()` is transaction_timestamp(), so every age below is
  // measured from the same instant by construction.
  assert.equal(sent[1], "SELECT now() AS at");
  assert.equal(sent.length, 6);
  assert.equal(state.released, 1);
});

test("what the read returns is what the page may render, and no more", async () => {
  const readFleetStatus = await withPool(goodRows);
  const snap = await readFleetStatus();
  assert.ok(snap.ok);

  assert.equal(snap.at, NOW.toISOString());
  assert.equal(snap.nodes[0].lastSeenAgeS, 6.5);
  assert.equal(snap.nodes[0].freshness, "heartbeating");
  assert.equal(snap.nodes[0].memoryBytes, 34359738368);
  assert.equal(snap.placements[0].placedAgeS, 900);
  assert.equal(snap.placements[0].faults[0].shieldsDeploys, true);
  assert.equal(snap.counts.shielding, 1);

  const rendered = JSON.stringify(snap);
  assert.doesNotMatch(rendered, /postgres:\/\//);
  assert.doesNotMatch(rendered, /--token=abc/);
  assert.doesNotMatch(rendered, /app-myapp-DATABASE_URL/);
  assert.deepEqual(Object.keys(snap.placements[0].spec).sort(), [
    "cpuShares",
    "healthPath",
    "image",
    "memoryBytes",
    "port",
    "processes",
  ]);
});

test("a read that fails names the relation and returns no rows to mistake for a quiet fleet", async () => {
  const readFleetStatus = await withPool((sql) => {
    if (sql.includes("fleet_process_faults")) throw serverError("column f.reported_at does not exist");
    return goodRows(sql);
  });
  const snap = await readFleetStatus();

  assert.ok(!snap.ok);
  assert.match(snap.error, /fleetStatus \(reading fleet_process_faults\)/);
  assert.match(snap.error, /column f\.reported_at does not exist/);

  // The failure must be UNREADABLE as an empty fleet. A `faults: []` here is the
  // single worst thing this surface can render: it says "nothing is failing"
  // when the truth is "we could not ask".
  const anySnap = snap as Record<string, unknown>;
  assert.equal("nodes" in anySnap, false);
  assert.equal("placements" in anySnap, false);
  assert.equal("orphanFaults" in anySnap, false);
  assert.equal("counts" in anySnap, false);

  // Rolled back and returned, so a failed read costs no pooled client. The
  // control plane runs `max: 3`.
  assert.ok(sent.includes("ROLLBACK"));
  assert.ok(!sent.includes("COMMIT"));
  assert.equal(state.released, 1);
});

test("a failure in the FIRST read is named for the first read, not the last", async () => {
  const readFleetStatus = await withPool((sql) => {
    if (sql.includes("fleet_nodes")) throw serverError("permission denied for table fleet_nodes");
    return goodRows(sql);
  });
  const snap = await readFleetStatus();
  assert.ok(!snap.ok);
  // One try/catch around a transaction gets the cascade "current transaction is
  // aborted" for every later statement, which would name whichever relation ran
  // last. The relation has to travel from the point of failure.
  assert.match(snap.error, /reading fleet_nodes/);
  assert.doesNotMatch(snap.error, /fleet_process_faults/);
});

test("a connection failure says so without naming the host", async () => {
  const readFleetStatus = await withPool(goodRows, {
    connectThrows: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" }),
  });
  const snap = await readFleetStatus();
  assert.ok(!snap.ok);
  assert.match(snap.error, /could not reach the database \(ECONNREFUSED\)/);
  assert.doesNotMatch(snap.error, /127\.0\.0\.1/);
  assert.doesNotMatch(snap.error, /5433/);
});
