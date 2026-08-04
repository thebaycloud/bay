import type { PoolClient } from "pg";
import { getPool } from "./db";
import { assertReadOnly, readErrorDetail, readErrorMessage, redact } from "./analytics/queries";

const DB = "supersonic_platform";

/**
 * What the fleet has been told to hold, and what it says is failing.
 *
 * Today the only way to see what a node holds is to ssh to it and curl
 * 127.0.0.1:9900/status. An operator without ssh — or with an expired gcloud
 * token — is blind, during exactly the incident where being blind costs most.
 * Everything below is answered from the control plane's own tables, so it works
 * when the node does not.
 *
 * READ-ONLY, and enforced the way lib/analytics/queries.ts enforces it: every
 * statement runs inside `BEGIN READ ONLY`, which makes Postgres itself refuse a
 * write whatever the SQL says, and every statement is checked by `assertReadOnly`
 * before it is sent so the mistake is visible in review rather than at a
 * transaction boundary.
 *
 * WHAT THIS CANNOT SAY, and says so rather than guessing
 *
 * A placement is what the control plane TOLD a node. Nothing in the ten-second
 * sync reports running processes — services/fleet/agent/desired.go carries
 * identity plus start failures and nothing else — so no table here knows whether
 * a process is up. A page that implied otherwise would be the same fail-open
 * this whole fleet-status feature exists to close: silence at the load balancer
 * once meant "the app is broken", and the cost of that reading was an LLM repair
 * agent let loose on a customer's repository over an outage we caused.
 *
 * ONE TRANSACTION, ONE CLOCK, ONE VERDICT
 *
 * All four statements share one `BEGIN READ ONLY`, so `now()` — which is
 * `transaction_timestamp()` — is the same instant in every age this returns. A
 * fleet whose nodes were aged against one clock and whose faults were aged
 * against another could show a fault that shields deploys next to a node that is
 * too stale to be shielding anything.
 *
 * That is also why there is no per-statement recovery. An error inside a
 * transaction block puts it in 25P02 and every later statement returns
 * "current transaction is aborted", so partial success is not on the menu: the
 * snapshot is whole or it is a NAMED FAILURE. `FleetSnapshot` is a discriminated
 * union for that reason — the failed variant has no `nodes` and no `placements`
 * at all, so neither the page nor an API client can render a broken read as a
 * quiet fleet.
 */

/**
 * How long a node may be silent before the control plane stops claiming to know.
 *
 * The same 90 seconds `chooseNode` and `nodeFaultFor` use (lib/fleet.ts), and
 * test/fleet-status.test.ts fails when they stop agreeing. Note the comparison
 * is STRICT: the SQL is `last_seen > now() - interval '90 seconds'`, so at an age
 * of exactly 90 the database already says stale.
 */
export const STALE_AFTER_SECONDS = 90;

export function isFresh(ageS: number): boolean {
  return ageS < STALE_AFTER_SECONDS;
}

/**
 * What the control plane is entitled to say about a node.
 *
 * "heartbeating", NOT "reporting", and the difference is the whole honesty of
 * this surface. Nothing stores that a node sent the `processes` field:
 * app/api/fleet/sync/route.ts calls `recordNodeFaults` only when the field is
 * present and writes no marker either way. So an agent binary built before the
 * field existed heartbeats freshly and holds zero fault rows, and is
 * indistinguishable from an agent that reports and has nothing failing.
 *
 * And "unknown", NOT "down". `KillMode=process` (services/fleet/image/
 * provision.sh) means restarting the agent does not stop the sandboxes, so a
 * silent agent does not mean silent apps. Calling it down would invite exactly
 * the response — re-place its apps elsewhere — that puts two copies of an app on
 * the fleet at once.
 */
export type NodeFreshness = "heartbeating" | "unknown";

export function nodeFreshness(lastSeenAgeS: number): NodeFreshness {
  return isFresh(lastSeenAgeS) ? "heartbeating" : "unknown";
}

/**
 * The fault vocabulary the node decides in, mirrored from
 * services/fleet/agent/fault.go. Pinned by a test that reads the Go const block,
 * because this list existing in two places is exactly how the AppSpec drifted.
 *
 * A value NOT in this list is rendered verbatim rather than blanked.
 * db/014_fleet_status.sql deliberately refuses a CHECK constraint so a newer
 * agent's new value is stored and ignored by an older reader; an unrecognised
 * fault that vanished from the page would be a failure hidden in the forbidden
 * direction.
 */
export const KNOWN_FAULTS = ["", "node", "app", "unknown"] as const;

/**
 * How much fault text this page will render.
 *
 * The agent bounds `detail` to 400 runes (fault.go), but that is the honest
 * agent's discipline and not an invariant: db/014_fleet_status.sql:27 is plain
 * unbounded `text`, and `recordNodeFaults` inserts whatever the sync body
 * contained. FLEET_TOKEN is a shared secret, so any holder can write an
 * arbitrary `detail` for a node it can post as. Truncate on render rather than
 * trusting the producer.
 *
 * Deliberately NOT pinned to the agent's constant: if the agent ever raises its
 * limit, this page's bound should not move with it.
 */
export const DETAIL_LIMIT = 400;

/** Truncate by code point, so a multi-byte character is never split in half. */
export function boundDetail(detail: string): { text: string; truncated: boolean } {
  const runes = [...detail];
  if (runes.length <= DETAIL_LIMIT) return { text: detail, truncated: false };
  return { text: runes.slice(0, DETAIL_LIMIT).join(""), truncated: true };
}

/**
 * A node's memory, in the unit the machine was bought in.
 *
 * GiB and not GB, because `fleet_nodes.memory_bytes` is what the node read out
 * of its own cgroup — a 32GiB machine reporting 34359738368 must not render as
 * "34 GB" on a page an operator uses to decide whether it has room. An
 * unparseable value is an em dash rather than "0 GiB", which would read as a
 * machine with no memory.
 */
export function gib(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

// ─── the projection ───────────────────────────────────────────────────────────

/**
 * The only `AppSpec` fields that may be rendered.
 *
 * An allowlist, and picked by name rather than by deleting the dangerous ones:
 * `env` holds every resolved environment variable the pipeline built, which
 * includes DATABASE_URL — deploy-pipeline.ts pushes `${k}=${v}` into `extraEnv`
 * for every key Secret Manager refused, so a plaintext credential genuinely does
 * reach the placement spec. `secrets` holds Secret Manager resource ids, and
 * `processes[].command` holds start commands that carry tokens on the argv often
 * enough to matter. Deleting keys means a field added to `AppSpec` next year is
 * rendered by default; picking them means it is not.
 *
 * Never spread. `{...spec}` then delete is the shape this must not take.
 */
export const SPEC_FIELDS = ["image", "port", "memoryBytes", "cpuShares", "healthPath"] as const;

export interface SafeSpec {
  image?: unknown;
  port?: unknown;
  memoryBytes?: unknown;
  cpuShares?: unknown;
  healthPath?: unknown;
  /** Name and kind only — never `command`, never a port-and-secret shaped field. */
  processes?: Array<{ name: unknown; kind: unknown }>;
}

export function safeSpec(spec: unknown): SafeSpec {
  const out: SafeSpec = {};
  if (!spec || typeof spec !== "object") return out;
  const s = spec as Record<string, unknown>;
  for (const f of SPEC_FIELDS) if (s[f] !== undefined) out[f] = s[f];
  if (Array.isArray(s.processes)) {
    out.processes = s.processes.map((p) => {
      const q = (p ?? {}) as Record<string, unknown>;
      return { name: q.name, kind: q.kind };
    });
  }
  return out;
}

// ─── rows, as Postgres hands them over ────────────────────────────────────────

/**
 * The raw shapes, with every number widened to `number | string`.
 *
 * That is not defensiveness. `extract(epoch from ...)` returns `numeric` on
 * PostgreSQL 14+ and node-pg hands `numeric` (OID 1700) and `bigint` (OID 20)
 * back as JS STRINGS — lib/fleet.ts:263 already types a `count()` as `string`
 * for this reason. The SQL below casts every age to `::float8` so the driver
 * parses it as a number, and the mappers coerce anyway: a `"91.2"` that reached
 * `isFresh` unconverted would compare `"91.2" < 90` as false, which happens to
 * be right, while `"9.2" < 90` is also false, which is a stale verdict on a node
 * that reported nine seconds ago.
 */
export interface RawNodeRow {
  name: string;
  zone: string;
  internal_ip: string;
  cpus: number | string;
  memory_bytes: number | string;
  drain: boolean;
  last_seen_age_s: number | string;
}

export interface RawPlacementRow {
  slug: string;
  node: string;
  spec: unknown;
  placed_age_s: number | string;
  runtime: string | null;
}

export interface RawFaultRow {
  slug: string;
  node: string;
  process: string;
  fault: string;
  detail: string | null;
  reported_age_s: number | string;
}

export interface NodeRow {
  name: string;
  zone: string;
  internalIp: string;
  cpus: number;
  memoryBytes: number;
  drain: boolean;
  lastSeenAgeS: number;
}

export interface PlacementRow {
  slug: string;
  node: string;
  spec: SafeSpec;
  placedAgeS: number;
  runtime: string | null;
}

export interface FaultRow {
  slug: string;
  node: string;
  process: string;
  fault: string;
  detail: string;
  reportedAgeS: number;
}

/**
 * `Number()` and not `parseFloat`, and never a fallback to 0.
 *
 * A missing or unparseable age becomes NaN, and every comparison against NaN is
 * false — so `isFresh` says stale and `shieldsDeploys` says no. Both are the
 * non-claiming direction. A fallback of 0 would read as "reported just now",
 * which is the one answer this surface must never invent.
 */
function age(v: number | string | null | undefined): number {
  return Number(v);
}

export function toNodeRow(r: RawNodeRow): NodeRow {
  return {
    name: r.name,
    zone: r.zone,
    internalIp: r.internal_ip,
    cpus: age(r.cpus),
    memoryBytes: age(r.memory_bytes),
    drain: Boolean(r.drain),
    lastSeenAgeS: age(r.last_seen_age_s),
  };
}

export function toPlacementRow(r: RawPlacementRow): PlacementRow {
  return {
    slug: r.slug,
    node: r.node,
    spec: safeSpec(r.spec),
    placedAgeS: age(r.placed_age_s),
    runtime: r.runtime ?? null,
  };
}

export function toFaultRow(r: RawFaultRow): FaultRow {
  return {
    slug: r.slug,
    node: r.node,
    process: r.process,
    fault: r.fault,
    detail: r.detail ?? "",
    reportedAgeS: age(r.reported_age_s),
  };
}

// ─── what a fault actually does ───────────────────────────────────────────────

export interface ShieldInput {
  fault: string;
  reportedAgeS: number;
  nodeLastSeenAgeS: number;
  hasPlacement: boolean;
}

/**
 * Would this fault row keep the repair agent away from the customer's repo?
 *
 * The four conditions are `nodeFaultFor`'s, not this file's opinion: a node
 * fault, a fresh node, a fresh row, and a placement for that exact (slug, node).
 * When they hold, a failed fleet deploy's reason is rewritten as FLEET_NODE_FAULT
 * (lib/fleet-place.ts), which PLATFORM_MARKERS reads as "not the app's fault".
 *
 * test/fleet-status.test.ts reads `nodeFaultFor`'s SQL out of lib/fleet.ts and
 * pins its clause set to exactly these four, because a truth table written
 * beside this function proves only that the two agree with each other. A fifth
 * condition added to the deploy path must fail that test loudly rather than
 * leave this page quietly overstating what is shielded.
 */
export function shieldsDeploys(f: ShieldInput): boolean {
  return (
    f.fault === "node" &&
    f.hasPlacement &&
    isFresh(f.nodeLastSeenAgeS) &&
    isFresh(f.reportedAgeS)
  );
}

/** Which of the four conditions failed, in words an operator can act on. */
export function whyNotShielding(f: ShieldInput): string[] {
  const why: string[] = [];
  if (f.fault !== "node") why.push(`the node blamed "${f.fault || "nothing"}", not itself`);
  if (!f.hasPlacement) why.push("nothing is placed for this app on this node");
  if (!isFresh(f.nodeLastSeenAgeS)) why.push(`the node has been silent for ${Math.round(f.nodeLastSeenAgeS)}s`);
  if (!isFresh(f.reportedAgeS)) why.push(`the fault itself is ${Math.round(f.reportedAgeS)}s old`);
  return why;
}

// ─── the view ─────────────────────────────────────────────────────────────────

export interface FaultView {
  slug: string;
  node: string;
  process: string;
  /** Verbatim, whatever the agent said. */
  fault: string;
  /** Is this a value services/fleet/agent/fault.go can produce? */
  known: boolean;
  detail: string;
  detailTruncated: boolean;
  reportedAgeS: number;
  shieldsDeploys: boolean;
  whyNotShielding: string[];
}

export interface NodeView {
  name: string;
  zone: string;
  internalIp: string;
  cpus: number;
  memoryBytes: number;
  drain: boolean;
  lastSeenAgeS: number;
  /** Two values only. `drain` is a SEPARATE fact and never replaces this one. */
  freshness: NodeFreshness;
  placed: number;
  faults: number;
}

export interface PlacementView {
  slug: string;
  node: string;
  spec: SafeSpec;
  placedAgeS: number;
  /** `apps.runtime`, or null when this slug has no row in `apps` at all. */
  runtime: string | null;
  nodeFreshness: NodeFreshness | null;
  faults: FaultView[];
  warnings: string[];
}

export interface FleetView {
  at: string;
  staleAfterSeconds: number;
  nodes: NodeView[];
  placements: PlacementView[];
  /** Faults whose (slug, node) has no placement. They shield nothing. */
  orphanFaults: FaultView[];
  counts: {
    nodes: number;
    heartbeating: number;
    placements: number;
    faults: number;
    shielding: number;
  };
}

/**
 * A whole snapshot or a named failure — never something in between.
 *
 * The failed variant carries NO `nodes` and NO `placements` keys, so
 * `snapshot.nodes` does not typecheck without narrowing on `ok` and is
 * `undefined` at runtime. An error shape with empty arrays would render as a
 * fleet holding nothing, which is the one confusion this surface must not
 * create: lib/analytics/queries.ts is this project's own written argument that a
 * broken read and a quiet week must never look alike.
 */
export type FleetSnapshot =
  | ({ ok: true } & FleetView)
  | { ok: false; at: string; staleAfterSeconds: number; error: string };

export interface FleetRows {
  at: Date;
  nodes: NodeRow[];
  placements: PlacementRow[];
  faults: FaultRow[];
}

/**
 * The rows, joined into what an operator reads. Pure — no clock, no database.
 *
 * Placements are keyed on (slug, node) and never collapsed to one entry per
 * slug. db/013_fleet.sql makes that the primary key and lib/fleet.ts:93-101
 * names two placements for one slug as "two copies of the app running at once,
 * which is exactly what this sequence exists to prevent". A view that showed one
 * row per app would hide the single hazard it most needs to show.
 */
export function buildFleetView(rows: FleetRows): FleetView {
  const nodeByName = new Map(rows.nodes.map((n) => [n.name, n]));
  const placementKeys = new Set(rows.placements.map((p) => `${p.slug} ${p.node}`));

  const nodesForSlug = new Map<string, string[]>();
  for (const p of rows.placements) {
    const seen = nodesForSlug.get(p.slug) ?? [];
    seen.push(p.node);
    nodesForSlug.set(p.slug, seen);
  }

  const viewFault = (f: FaultRow): FaultView => {
    const bound = boundDetail(f.detail);
    const input: ShieldInput = {
      fault: f.fault,
      reportedAgeS: f.reportedAgeS,
      nodeLastSeenAgeS: nodeByName.get(f.node)?.lastSeenAgeS ?? NaN,
      hasPlacement: placementKeys.has(`${f.slug} ${f.node}`),
    };
    const shields = shieldsDeploys(input);
    return {
      slug: f.slug,
      node: f.node,
      process: f.process,
      fault: f.fault,
      known: (KNOWN_FAULTS as readonly string[]).includes(f.fault),
      detail: bound.text,
      detailTruncated: bound.truncated,
      reportedAgeS: f.reportedAgeS,
      shieldsDeploys: shields,
      whyNotShielding: shields ? [] : whyNotShielding(input),
    };
  };

  const faults = rows.faults.map(viewFault);

  const placements: PlacementView[] = rows.placements.map((p) => {
    const mine = faults.filter((f) => f.slug === p.slug && f.node === p.node);
    const node = nodeByName.get(p.node);
    const warnings: string[] = [];

    if (p.runtime === null) {
      warnings.push("no row in the apps table for this slug, so no node is ever handed it");
    } else if (p.runtime !== "fleet") {
      warnings.push(
        `apps.runtime is "${p.runtime}", so the placement is stored but never handed to the node`,
      );
    }
    if (!node) warnings.push("no row in fleet_nodes for this node");

    const alsoOn = (nodesForSlug.get(p.slug) ?? []).filter((n) => n !== p.node);
    if (alsoOn.length) {
      warnings.push(`also placed on ${alsoOn.join(", ")} — two placements is two copies`);
    }
    for (const f of mine) {
      if (!f.shieldsDeploys) {
        warnings.push(
          `the "${f.process}" fault does not shield a failed deploy: ${f.whyNotShielding.join("; ")}`,
        );
      }
    }

    return {
      slug: p.slug,
      node: p.node,
      spec: p.spec,
      placedAgeS: p.placedAgeS,
      runtime: p.runtime,
      nodeFreshness: node ? nodeFreshness(node.lastSeenAgeS) : null,
      faults: mine,
      warnings,
    };
  });

  const nodes: NodeView[] = rows.nodes.map((n) => ({
    name: n.name,
    zone: n.zone,
    internalIp: n.internalIp,
    cpus: n.cpus,
    memoryBytes: n.memoryBytes,
    drain: n.drain,
    lastSeenAgeS: n.lastSeenAgeS,
    freshness: nodeFreshness(n.lastSeenAgeS),
    placed: rows.placements.filter((p) => p.node === n.name).length,
    faults: faults.filter((f) => f.node === n.name).length,
  }));

  const orphanFaults = faults.filter((f) => !placementKeys.has(`${f.slug} ${f.node}`));

  return {
    at: rows.at.toISOString(),
    staleAfterSeconds: STALE_AFTER_SECONDS,
    nodes,
    placements,
    orphanFaults,
    counts: {
      nodes: nodes.length,
      heartbeating: nodes.filter((n) => n.freshness === "heartbeating").length,
      placements: placements.length,
      faults: faults.length,
      shielding: faults.filter((f) => f.shieldsDeploys).length,
    },
  };
}

// ─── the read ─────────────────────────────────────────────────────────────────

/**
 * The transaction's own clock, so every age below is measured from one instant.
 * `now()` is `transaction_timestamp()`, so this is the same value the three
 * reads subtract from.
 */
const AT_SQL = `SELECT now() AS at`;

const NODES_SQL = `
  SELECT n.name,
         n.zone,
         n.internal_ip,
         n.cpus,
         n.memory_bytes,
         n.drain,
         extract(epoch from now() - n.last_seen)::float8 AS last_seen_age_s
    FROM fleet_nodes n
   ORDER BY n.name`;

/**
 * LEFT JOIN, not JOIN: a placement whose app row vanished is precisely the state
 * worth seeing, and an inner join would hide it. `a.status` is deliberately NOT
 * selected — it is latched to 'live' at deploy time by lib/apps.ts and never
 * revisited, so a `live` cell beside a placement would re-create the "no fault
 * row means it is up" reading this whole surface exists to refuse.
 */
const PLACEMENTS_SQL = `
  SELECT p.slug,
         p.node,
         p.spec,
         extract(epoch from now() - p.placed_at)::float8 AS placed_age_s,
         a.runtime
    FROM fleet_placements p
    LEFT JOIN apps a ON a.slug = p.slug
   ORDER BY p.slug, p.node`;

const FAULTS_SQL = `
  SELECT f.slug,
         f.node,
         f.process,
         f.fault,
         f.detail,
         extract(epoch from now() - f.reported_at)::float8 AS reported_age_s
    FROM fleet_process_faults f
   ORDER BY f.slug, f.node, f.process`;

export const READ_STATEMENTS = [AT_SQL, NODES_SQL, PLACEMENTS_SQL, FAULTS_SQL] as const;

/**
 * The whole snapshot, or the database's own words about why there isn't one.
 *
 * The relation is tracked statement by statement so the failure names the table
 * that broke rather than whichever one happened to be last — `readErrorMessage`
 * exists for exactly that, and "column f.reported_at does not exist" is worth
 * more than "something went wrong".
 */
export async function readFleetStatus(): Promise<FleetSnapshot> {
  for (const sql of READ_STATEMENTS) assertReadOnly(sql);

  const failed = (relation: string, e: unknown): FleetSnapshot => {
    // Scrubbed, not raw. The stack names code paths rather than data, but it is
    // redacted too rather than trusted to contain none.
    const stack = e instanceof Error && e.stack ? `\n${redact(e.stack)}` : "";
    console.error(`fleet status read failed: ${relation}: ${readErrorDetail(e)}${stack}`);
    return {
      ok: false,
      at: new Date().toISOString(),
      staleAfterSeconds: STALE_AFTER_SECONDS,
      error: readErrorMessage(e, "fleetStatus", relation),
    };
  };

  // Checked out in its own try, because `connect()` is where a control plane
  // that cannot reach Postgres at all fails — and an exception escaping this
  // function would reach the page as an unhandled 500 rather than as the named
  // failure the whole return type exists to carry.
  let client: PoolClient;
  try {
    client = await getPool(DB).connect();
  } catch (e) {
    return failed("the connection", e);
  }

  let relation = "the transaction";
  try {
    await client.query("BEGIN READ ONLY");
    relation = "the transaction clock";
    const at = await client.query(AT_SQL);
    relation = "fleet_nodes";
    const nodes = await client.query(NODES_SQL);
    relation = "fleet_placements";
    const placements = await client.query(PLACEMENTS_SQL);
    relation = "fleet_process_faults";
    const faults = await client.query(FAULTS_SQL);
    await client.query("COMMIT");

    return {
      ok: true,
      ...buildFleetView({
        at: (at.rows[0]?.at as Date | undefined) ?? new Date(),
        nodes: (nodes.rows as RawNodeRow[]).map(toNodeRow),
        placements: (placements.rows as RawPlacementRow[]).map(toPlacementRow),
        faults: (faults.rows as RawFaultRow[]).map(toFaultRow),
      }),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return failed(relation, e);
  } finally {
    // Always returned, including when the query threw: a leaked client on a
    // control plane with `max: 3` takes a third of production's database
    // capacity with it.
    client.release();
  }
}
