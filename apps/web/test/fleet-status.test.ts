import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertReadOnly } from "../lib/analytics/queries";
import { buildAppSpec } from "../lib/fleet-spec";
import { resolveProcess, type ResolvedProcess } from "../lib/processes";
import {
  DETAIL_LIMIT,
  KNOWN_FAULTS,
  READ_STATEMENTS,
  STALE_AFTER_SECONDS,
  boundDetail,
  buildFleetView,
  nodeFreshness,
  safeSpec,
  shieldsDeploys,
  toFaultRow,
  toNodeRow,
  toPlacementRow,
  type FaultRow,
  type NodeRow,
  type PlacementRow,
} from "../lib/fleet-status";

/**
 * What this page is allowed to claim, checked against the things that decide it.
 *
 * The rule running through every test here: where this module reads a fact some
 * other file produces — the 90-second window, `nodeFaultFor`'s clause set, the
 * agent's fault vocabulary, the spec `buildAppSpec` builds — the fixture is
 * BUILT BY THE PRODUCER or READ OUT OF IT. A hand-written expectation beside a
 * hand-written implementation proves only that the same imagination wrote both.
 */

const fleetSrc = () => readFileSync(new URL("../lib/fleet.ts", import.meta.url), "utf8");

/** `nodeFaultFor`'s body, out of lib/fleet.ts — the function that steers deploys. */
function nodeFaultForSql(): string {
  const src = fleetSrc();
  const fn = src.match(/export async function nodeFaultFor[\s\S]*?\n\}/);
  assert.ok(fn, "could not find nodeFaultFor in lib/fleet.ts");
  const sql = fn[0].match(/`([^`]*)`/);
  assert.ok(sql, "could not find nodeFaultFor's SQL literal");
  return sql[1];
}

const rows = (o: Partial<{ nodes: NodeRow[]; placements: PlacementRow[]; faults: FaultRow[] }> = {}) => ({
  at: new Date("2026-08-05T12:00:00Z"),
  nodes: o.nodes ?? [],
  placements: o.placements ?? [],
  faults: o.faults ?? [],
});

const node = (o: Partial<NodeRow> = {}): NodeRow => ({
  name: "fleet-lab-1",
  zone: "europe-west2-a",
  internalIp: "10.0.0.7",
  cpus: 8,
  memoryBytes: 34359738368,
  drain: false,
  lastSeenAgeS: 4,
  ...o,
});

const placement = (o: Partial<PlacementRow> = {}): PlacementRow => ({
  slug: "myapp",
  node: "fleet-lab-1",
  spec: {},
  placedAgeS: 600,
  runtime: "fleet",
  ...o,
});

const fault = (o: Partial<FaultRow> = {}): FaultRow => ({
  slug: "myapp",
  node: "fleet-lab-1",
  process: "web",
  fault: "node",
  detail: "database path not answering",
  reportedAgeS: 8,
  ...o,
});

// ─── 1. the 90-second window is one number ────────────────────────────────────

test("the staleness window is the one lib/fleet.ts already uses", () => {
  const found = [...fleetSrc().matchAll(/interval '(\d+) seconds'/g)].map((m) => Number(m[1]));
  assert.ok(found.length >= 3, `expected lib/fleet.ts's freshness intervals, found ${found.length}`);
  assert.deepEqual([...new Set(found)], [STALE_AFTER_SECONDS]);
});

// ─── 2. stale is unknown, never down ──────────────────────────────────────────

test("a node that stopped reporting is unknown, and never down", () => {
  const verdict = nodeFreshness(91);
  assert.equal(verdict, "unknown");
  // KillMode=process means a silent agent does not mean silent apps. A page that
  // said "down" would invite re-placing its apps, which is two copies at once.
  assert.doesNotMatch(verdict, /down/i);
  assert.doesNotMatch(verdict, /offline/i);
  assert.doesNotMatch(verdict, /dead/i);
  // Nothing stores that a node SENT the processes field, so "reporting" is a
  // claim the control plane cannot make.
  assert.doesNotMatch(verdict, /^reporting$/);
  assert.equal(nodeFreshness(4), "heartbeating");
});

test("the freshness boundary is the SQL's, strictly", () => {
  // `last_seen > now() - interval '90 seconds'` is `age < 90`. At exactly 90 the
  // database already says stale, so this must too.
  assert.equal(nodeFreshness(89.9), "heartbeating");
  assert.equal(nodeFreshness(STALE_AFTER_SECONDS), "unknown");
  assert.equal(nodeFreshness(90.1), "unknown");
});

test("draining is its own fact and never replaces unknown", () => {
  const v = buildFleetView(rows({ nodes: [node({ drain: true, lastSeenAgeS: 3600 })] }));
  // db/013_fleet.sql makes drain and last_seen separate columns because they are
  // separate facts. A node draining AND silent for an hour must not read as an
  // orderly drain.
  assert.equal(v.nodes[0].freshness, "unknown");
  assert.equal(v.nodes[0].drain, true);
  assert.equal(v.counts.heartbeating, 0);
});

// ─── 3. the shield is pinned to the function that actually shields ────────────

test("shieldsDeploys implements nodeFaultFor's clause set and nothing more", () => {
  const sql = nodeFaultForSql();

  const where = sql.match(/WHERE([\s\S]*?)ORDER BY/);
  assert.ok(where, "could not find nodeFaultFor's WHERE clause");
  const predicates = where[1]
    .split(/\bAND\b/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Exactly four, so a FIFTH condition added to the deploy path fails HERE
  // loudly instead of leaving this page quietly overstating what is shielded.
  assert.deepEqual(predicates.sort(), [
    "f.fault = 'node'",
    "f.reported_at > now() - interval '90 seconds'",
    "f.slug = $1",
    "n.last_seen > now() - interval '90 seconds'",
  ]);

  // And the placement condition, which lives in a JOIN rather than the WHERE.
  const joins = [...sql.matchAll(/JOIN ([\s\S]*?)(?=\n\s*(?:JOIN|WHERE))/g)].map((m) =>
    m[1].replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(joins, [
    "fleet_nodes n ON n.name = f.node",
    "fleet_placements p ON p.slug = f.slug AND p.node = f.node",
  ]);
});

test("all four conditions are load-bearing, and each one alone withholds the shield", () => {
  const fresh = { fault: "node", reportedAgeS: 8, nodeLastSeenAgeS: 4, hasPlacement: true };
  assert.equal(shieldsDeploys(fresh), true);
  assert.equal(shieldsDeploys({ ...fresh, fault: "app" }), false);
  assert.equal(shieldsDeploys({ ...fresh, fault: "unknown" }), false);
  assert.equal(shieldsDeploys({ ...fresh, hasPlacement: false }), false);
  assert.equal(shieldsDeploys({ ...fresh, nodeLastSeenAgeS: 91 }), false);
  assert.equal(shieldsDeploys({ ...fresh, reportedAgeS: 91 }), false);
  // The boundary, on the SQL's side of it.
  assert.equal(shieldsDeploys({ ...fresh, reportedAgeS: 89.9 }), true);
  assert.equal(shieldsDeploys({ ...fresh, reportedAgeS: STALE_AFTER_SECONDS }), false);
  assert.equal(shieldsDeploys({ ...fresh, reportedAgeS: 90.1 }), false);
  // An age that never parsed is not a shield.
  assert.equal(shieldsDeploys({ ...fresh, reportedAgeS: NaN }), false);
});

test("a fault that shields nothing says which condition failed", () => {
  const v = buildFleetView(
    rows({
      nodes: [node({ lastSeenAgeS: 400 })],
      placements: [placement()],
      faults: [fault()],
    }),
  );
  const f = v.placements[0].faults[0];
  assert.equal(f.shieldsDeploys, false);
  assert.equal(f.whyNotShielding.length, 1);
  assert.match(f.whyNotShielding[0], /silent for 400s/);
  assert.ok(v.placements[0].warnings.some((w) => w.includes("does not shield")));
  assert.equal(v.counts.shielding, 0);
});

// ─── 4. the projection cannot leak ────────────────────────────────────────────

test("the rendered spec carries no env, no secret reference and no command", () => {
  // Built by the producer. A hand-written spec would prove only that safeSpec
  // drops the keys this test remembered to invent.
  const spec = buildAppSpec({
    slug: "myapp",
    image: "us-central1-docker.pkg.dev/p/r/myapp:latest",
    env: [
      "DATABASE_URL=postgres://u:p@h/db?sslmode=require",
      "API_KEY=sk-live-xyz",
    ],
    secrets: [{ key: "DATABASE_URL", name: "app-myapp-DATABASE_URL" }],
    processes: [resolveProcess("web", { command: "npm start --token=abc" })] as ResolvedProcess[],
  });
  // The fixture is only worth anything if the dangerous fields are really there.
  assert.ok(spec.env?.DATABASE_URL?.includes("postgres://"), "fixture lost its env");
  assert.ok(spec.secrets?.DATABASE_URL, "fixture lost its secret reference");
  assert.ok(spec.processes?.[0].command?.join(" ").includes("--token=abc"), "fixture lost its command");

  const out = safeSpec(spec);

  // A LITERAL, not `[...SPEC_FIELDS, "processes"]`. Deriving the expectation from
  // the constant the implementation projects with can never fail when that
  // constant widens, which is the whole failure this assertion is here to catch.
  assert.deepEqual(Object.keys(out).sort(), [
    "cpuShares",
    "healthPath",
    "image",
    "memoryBytes",
    "port",
    "processes",
  ]);
  assert.deepEqual(Object.keys(out.processes![0]).sort(), ["kind", "name"]);

  const rendered = JSON.stringify(out);
  assert.doesNotMatch(rendered, /postgres:\/\//);
  assert.doesNotMatch(rendered, /sk-live-xyz/);
  assert.doesNotMatch(rendered, /--token=abc/);
  assert.doesNotMatch(rendered, /app-myapp-DATABASE_URL/);
});

test("a spec that is not an object renders as nothing rather than throwing", () => {
  for (const junk of [null, undefined, "spec", 7, []]) {
    assert.deepEqual(safeSpec(junk), {});
  }
});

// ─── 5. no mutating SQL in the read module ────────────────────────────────────

test("the fleet status module contains no mutating SQL anywhere in it", () => {
  const src = readFileSync(new URL("../lib/fleet-status.ts", import.meta.url), "utf8");
  const statements = src.match(/`[^`]*\bFROM\b[^`]*`/gi) ?? [];
  // Without this the test passes when the regex matches nothing at all.
  assert.ok(statements.length >= 3, `expected to find the SQL literals, found ${statements.length}`);
  for (const s of statements) assert.doesNotThrow(() => assertReadOnly(s.slice(1, -1)), s);
});

test("every statement the read actually sends is read-only", () => {
  assert.equal(READ_STATEMENTS.length, 4);
  for (const s of READ_STATEMENTS) assert.doesNotThrow(() => assertReadOnly(s), s);
});

test("every age is cast in the SQL, because numeric arrives as a string", () => {
  const casts = READ_STATEMENTS.join("\n").match(/extract\(epoch from[\s\S]*?\)::float8/g) ?? [];
  assert.equal(casts.length, 3, "each of the three ages must be cast to float8");
});

// ─── 6. the fault vocabulary comes from the agent ─────────────────────────────

test("the faults this page knows how to label are the agent's own", () => {
  const src = readFileSync(
    resolve(process.cwd(), "../../services/fleet/agent/fault.go"),
    "utf8",
  );
  const block = src.match(/const \(([\s\S]*?)\n\)/);
  assert.ok(block, "could not find the Fault const block in the agent");
  const values = [...block[1].matchAll(/Fault\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 4, `expected the agent's fault values, found ${values.length}`);
  assert.deepEqual([...values].sort(), [...KNOWN_FAULTS].sort());
});

test("a fault value this reader does not know renders as itself", () => {
  // db/014_fleet_status.sql deliberately refuses a CHECK constraint so a newer
  // agent's new value is stored and ignored rather than rejected. Ignored must
  // not mean invisible.
  const v = buildFleetView(rows({ faults: [fault({ fault: "quota" })] }));
  const f = v.orphanFaults[0];
  assert.equal(f.fault, "quota");
  assert.equal(f.known, false);
  assert.equal(f.shieldsDeploys, false);
  assert.equal(v.counts.faults, 1);
});

test("fault text is bounded here, not trusted to have been bounded on the node", () => {
  // The column is unbounded `text` and any FLEET_TOKEN holder can write it.
  const huge = "x".repeat(5000);
  const v = buildFleetView(rows({ faults: [fault({ detail: huge })] }));
  assert.equal(v.orphanFaults[0].detail.length, DETAIL_LIMIT);
  assert.equal(v.orphanFaults[0].detailTruncated, true);
  assert.equal(boundDetail("short").truncated, false);
  // Truncated by code point, so a multi-byte character is never split in half.
  const emoji = "\u{1F600}".repeat(DETAIL_LIMIT + 10);
  assert.equal([...boundDetail(emoji).text].length, DETAIL_LIMIT);
});

// ─── 7. ages arrive as strings and must survive it ────────────────────────────

test("an age the driver returned as a string is a number by the time it is judged", () => {
  const n = toNodeRow({
    name: "fleet-lab-1",
    zone: "europe-west2-a",
    internal_ip: "10.0.0.7",
    cpus: "8",
    memory_bytes: "34359738368",
    drain: false,
    last_seen_age_s: "91.2",
  });
  assert.equal(n.lastSeenAgeS, 91.2);
  assert.equal(typeof n.lastSeenAgeS, "number");
  assert.equal(n.memoryBytes, 34359738368);
  assert.equal(n.cpus, 8);
  assert.equal(nodeFreshness(n.lastSeenAgeS), "unknown");

  // The one that actually bites: a nine-second age read as a string compares
  // false against 90 too, so a fresh node would read as unknown.
  const fresh = toNodeRow({
    name: "n",
    zone: "z",
    internal_ip: "10.0.0.8",
    cpus: "2",
    memory_bytes: "1",
    drain: false,
    last_seen_age_s: "9.2",
  });
  assert.equal(fresh.lastSeenAgeS, 9.2);
  assert.equal(nodeFreshness(fresh.lastSeenAgeS), "heartbeating");

  assert.equal(toPlacementRow({ slug: "a", node: "n", spec: {}, placed_age_s: "12.5", runtime: "fleet" }).placedAgeS, 12.5);
  assert.equal(
    toFaultRow({ slug: "a", node: "n", process: "web", fault: "node", detail: null, reported_age_s: "3.5" }).reportedAgeS,
    3.5,
  );
  // A null detail is "" and never the string "null".
  assert.equal(
    toFaultRow({ slug: "a", node: "n", process: "web", fault: "node", detail: null, reported_age_s: "3" }).detail,
    "",
  );
});

test("an age that never parsed withholds the claim rather than inventing one", () => {
  const n = toNodeRow({
    name: "n", zone: "z", internal_ip: "10.0.0.9", cpus: 1, memory_bytes: 1,
    drain: false, last_seen_age_s: "not a number",
  });
  assert.ok(Number.isNaN(n.lastSeenAgeS));
  // Unknown, not heartbeating: a fallback of 0 would read as "reported just now".
  assert.equal(nodeFreshness(n.lastSeenAgeS), "unknown");
});

// A failed snapshot is not an empty fleet — that one is behavioural, and lives
// in test/fleet-status-read.test.ts where the real read runs against a mocked
// driver. An assertion over this file's own type text would only restate it.

// ─── 9. double placement is visible ───────────────────────────────────────────

test("one slug placed on two nodes is two rows and a warning naming both", () => {
  const v = buildFleetView(
    rows({
      nodes: [node({ name: "fleet-lab-1" }), node({ name: "fleet-lab-2" })],
      placements: [
        placement({ node: "fleet-lab-1" }),
        placement({ node: "fleet-lab-2" }),
      ],
    }),
  );
  // Keyed on (slug, node) — the primary key — and never collapsed to one entry
  // per app, which is what would hide two copies running at once.
  assert.equal(v.placements.length, 2);
  assert.ok(v.placements[0].warnings.some((w) => w.includes("fleet-lab-2")));
  assert.ok(v.placements[1].warnings.some((w) => w.includes("fleet-lab-1")));
  assert.ok(v.placements[0].warnings.some((w) => /two placements is two copies/.test(w)));
});

// ─── what else the view has to say out loud ───────────────────────────────────

test("a placement the node is never handed says so", () => {
  // desiredFor filters on `a.runtime = 'fleet'`, so a placement beside any other
  // runtime is stored and never served.
  const cloudrun = buildFleetView(rows({ nodes: [node()], placements: [placement({ runtime: "cloudrun" })] }));
  assert.ok(cloudrun.placements[0].warnings.some((w) => w.includes("never handed to the node")));

  const orphaned = buildFleetView(rows({ nodes: [node()], placements: [placement({ runtime: null })] }));
  assert.ok(orphaned.placements[0].warnings.some((w) => w.includes("no row in the apps table")));

  const fine = buildFleetView(rows({ nodes: [node()], placements: [placement()] }));
  assert.deepEqual(fine.placements[0].warnings, []);
});

test("a fault for something not placed is surfaced rather than dropped", () => {
  const v = buildFleetView(rows({ nodes: [node()], faults: [fault({ slug: "gone" })] }));
  assert.equal(v.orphanFaults.length, 1);
  assert.equal(v.orphanFaults[0].slug, "gone");
  assert.equal(v.orphanFaults[0].shieldsDeploys, false);
  assert.ok(v.orphanFaults[0].whyNotShielding.some((w) => w.includes("nothing is placed")));
});

test("a fault on a node with no row shields nothing, and does not throw", () => {
  const v = buildFleetView(rows({ placements: [placement()], faults: [fault()] }));
  assert.equal(v.placements[0].faults[0].shieldsDeploys, false);
  assert.equal(v.placements[0].nodeFreshness, null);
  assert.ok(v.placements[0].warnings.some((w) => w.includes("no row in fleet_nodes")));
});

test("a whole snapshot counts what it holds", () => {
  const v = buildFleetView(
    rows({
      nodes: [node(), node({ name: "fleet-lab-2", lastSeenAgeS: 900 })],
      placements: [placement(), placement({ slug: "other" })],
      faults: [fault(), fault({ slug: "other", fault: "app" })],
    }),
  );
  assert.deepEqual(v.counts, { nodes: 2, heartbeating: 1, placements: 2, faults: 2, shielding: 1 });
  assert.equal(v.nodes[0].placed, 2);
  assert.equal(v.nodes[0].faults, 2);
  assert.equal(v.nodes[1].placed, 0);
  assert.equal(v.staleAfterSeconds, STALE_AFTER_SECONDS);
  assert.equal(v.at, "2026-08-05T12:00:00.000Z");
});
