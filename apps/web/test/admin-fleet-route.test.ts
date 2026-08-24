import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { buildAppSpec } from "../lib/fleet-spec";
import { resolveProcess, type ResolvedProcess } from "../lib/processes";
import { buildFleetView, safeSpec, type FleetSnapshot } from "../lib/fleet-status";

/**
 * The gate, and what gets past it.
 *
 * Its own file because `mock.module` is process-wide within a module graph, and
 * module-scoped because it may only be installed once per process — the mocks
 * read whichever stand-in is current and each test swaps it.
 */

let admin: string | null = null;
let snapshot: FleetSnapshot = { ok: false, at: "", staleAfterSeconds: 90, error: "not set" };
let readCalls = 0;

mock.module("@/lib/admin", {
  namedExports: { currentAdminEmail: async () => admin },
});

mock.module("@/lib/fleet-status", {
  namedExports: {
    readFleetStatus: async () => {
      readCalls++;
      return snapshot;
    },
  },
});

const loaded = import("@/app/api/admin/fleet/route");

async function get(as: string | null, snap?: FleetSnapshot) {
  admin = as;
  if (snap) snapshot = snap;
  readCalls = 0;
  const { GET } = await loaded;
  return GET();
}

/** A snapshot whose spec came off the real builder, credentials and all. */
function realSnapshot(): FleetSnapshot {
  const spec = buildAppSpec({
    slug: "myapp",
    image: "us-central1-docker.pkg.dev/p/r/myapp:latest",
    env: ["DATABASE_URL=postgres://u:p@h/db?sslmode=require", "API_KEY=sk-live-xyz"],
    secrets: [{ key: "DATABASE_URL", name: "app-myapp-DATABASE_URL" }],
    processes: [resolveProcess("web", { command: "npm start --token=abc" })] as ResolvedProcess[],
  });
  return {
    ok: true,
    ...buildFleetView({
      at: new Date("2026-08-05T12:00:00Z"),
      nodes: [
        {
          name: "fleet-lab-1",
          zone: "europe-west2-a",
          internalIp: "10.0.0.7",
          cpus: 8,
          memoryBytes: 34359738368,
          drain: false,
          lastSeenAgeS: 6,
        },
      ],
      placements: [
        { slug: "myapp", node: "fleet-lab-1", spec: safeSpec(spec), placedAgeS: 900, runtime: "fleet" },
      ],
      faults: [],
    }),
  };
}

// ─── the gate ─────────────────────────────────────────────────────────────────

test("a caller who is not an operator gets 404 and costs production no read", async () => {
  const res = await get(null);
  assert.equal(res.status, 404);
  // THE assertion. "the body contains no slug" is trivially true of a 404 with a
  // null body and would hold however broken the gate was; that the reader was
  // never called is what proves the gate runs, and that it runs BEFORE any query
  // against shared production.
  assert.equal(readCalls, 0);
  // 404 rather than 403: there is no reason to confirm to a stranger that a
  // surface listing every tenant's app exists.
  assert.notEqual(res.status, 403);
  assert.notEqual(res.status, 401);
});

// ─── what gets past it ────────────────────────────────────────────────────────

test("an operator gets the snapshot, and it carries no credential from the spec", async () => {
  const res = await get("ops@acme.com", realSnapshot());
  assert.equal(res.status, 200);
  assert.equal(readCalls, 1);

  const text = await res.text();
  assert.doesNotMatch(text, /postgres:\/\//);
  assert.doesNotMatch(text, /sk-live-xyz/);
  assert.doesNotMatch(text, /--token=/);
  assert.doesNotMatch(text, /app-myapp-DATABASE_URL/);

  const body = JSON.parse(text);
  // The exact six, hardcoded. Comparing against the constant the implementation
  // projects with can never fail when that constant widens.
  assert.deepEqual(Object.keys(body.placements[0].spec).sort(), [
    "cpuShares",
    "healthPath",
    "image",
    "memoryBytes",
    "port",
    "processes",
  ]);
  assert.deepEqual(Object.keys(body.placements[0].spec.processes[0]).sort(), ["kind", "name"]);
  assert.equal(body.nodes[0].freshness, "heartbeating");
  assert.equal(body.staleAfterSeconds, 90);
});

test("the body names apps by slug and nobody by identity", async () => {
  const res = await get("ops@acme.com", realSnapshot());
  const text = await res.text();
  assert.match(text, /"slug":"myapp"/);
  // No owner id, no email, no session. This surface answers "what is the fleet
  // holding", which needs none of them.
  assert.doesNotMatch(text, /owner/i);
  assert.doesNotMatch(text, /@acme\.com/);
  assert.doesNotMatch(text, /"email"/);
});

// ─── a failed read ────────────────────────────────────────────────────────────

test("a failed read is a visible failure, never a clean fleet", async () => {
  const res = await get("ops@acme.com", {
    ok: false,
    at: "2026-08-05T12:00:00.000Z",
    staleAfterSeconds: 90,
    error: "fleetStatus (reading fleet_process_faults): column f.reported_at does not exist",
  });

  // A client that only checks the status must not read "we could not ask" as
  // "nothing is failing".
  assert.equal(res.status, 500);

  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.match(body.error, /column f\.reported_at does not exist/);

  // And no empty collection anywhere for a client to render as "nothing
  // failing". This is the shape of the failure, not a detail of it.
  assert.equal("nodes" in body, false);
  assert.equal("placements" in body, false);
  assert.equal("orphanFaults" in body, false);
  assert.equal("counts" in body, false);
  assert.doesNotMatch(text, /\[\]/);
});

test("an empty fleet and a broken read do not look alike", async () => {
  const empty = await get("ops@acme.com", {
    ok: true,
    ...buildFleetView({ at: new Date("2026-08-05T12:00:00Z"), nodes: [], placements: [], faults: [] }),
  });
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.ok, true);
  assert.deepEqual(emptyBody.nodes, []);
  assert.deepEqual(emptyBody.counts, { nodes: 0, heartbeating: 0, placements: 0, faults: 0, shielding: 0 });

  const broken = await get("ops@acme.com", {
    ok: false,
    at: "2026-08-05T12:00:00.000Z",
    staleAfterSeconds: 90,
    error: "fleetStatus (reading fleet_nodes): permission denied",
  });
  assert.equal(broken.status, 500);
  // The two must be distinguishable on the status alone, on `ok` alone, and on
  // the presence of rows alone.
  assert.notEqual(broken.status, empty.status);
  assert.notEqual((await broken.json()).ok, emptyBody.ok);
});
