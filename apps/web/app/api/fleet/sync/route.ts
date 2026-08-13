export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  heartbeatNode, desiredFor, drainingOn, recordNodeFaults, recordNodeRunning, peersFor,
  fleetGeneration, decideSync,
  type NodeReport, type ProcessFault, type ProcessState,
} from "@/lib/fleet";
import { renewLeases, promoteReady, recordDataUse } from "@/lib/reconcile";

/**
 * The only endpoint a fleet node talks to.
 *
 * One round trip does three things — register, heartbeat, and fetch desired
 * state — because they are the same fact from two directions and splitting them
 * would let a node be considered alive while holding a stale answer.
 *
 * PULL, never push. The node asks on its own clock and caches what it gets, so a
 * control plane that is down cannot take running apps with it. That is also why
 * this returns the FULL desired set rather than a delta: a delta is only correct
 * if the node's starting point is known, and after an outage it is not.
 */

/**
 * Node authentication.
 *
 * A shared secret today, and the whole security of the fleet's control channel
 * rests on it, so it is checked in constant time and the endpoint refuses to
 * work at all when it is unset — an unset secret must not silently mean "allow
 * everyone", which is the shape this kind of check usually fails in.
 *
 * The upgrade is a GCE instance identity token: the node already has one from
 * the metadata server, and verifying it against Google's keys would bind a node
 * to an actual VM instead of to a string that can be copied off any node. Worth
 * doing before the fleet leaves one project.
 *
 * One note for whoever builds that, established on 5 Aug and cheap to get wrong:
 * this route needs NO change to auth.config.ts. An agent designing the upgrade
 * proposed adding `/api/fleet/` to the middleware's `isPublic` list, and a
 * safety review stopped it — correctly, and for a reason beyond the one it
 * gave. The change is not merely risky, it is unnecessary: auth.config.ts
 * already returns true for any `/api/` request carrying an `Authorization:
 * Bearer` header, leaving the route to validate the token itself, which is
 * exactly what `authorised` below does. Widening `isPublic` would have made
 * every future route under this prefix reachable with no credential at all,
 * to buy nothing.
 */
function authorised(req: Request): boolean {
  const expected = process.env.FLEET_TOKEN;
  if (!expected) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  if (!authorised(req)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  let body: Partial<NodeReport> & { processes?: unknown; running?: unknown; withData?: unknown; version?: unknown; generation?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const { name, zone, internalIp } = body;
  if (!name || !zone || !internalIp) {
    return Response.json({ error: "name, zone and internalIp are required" }, { status: 400 });
  }

  try {
    await heartbeatNode({
      name,
      zone,
      internalIp,
      memoryBytes: Number(body.memoryBytes ?? 0),
      cpus: Number(body.cpus ?? 0),
      // Only when the node said. `undefined` means "this agent does not report",
      // which heartbeatSql turns into a COALESCE that leaves the stored value be.
      agentVersion: typeof body.version === "string" && body.version ? body.version : undefined,
    });
    // Only when the node actually sent the field. Absent means "this agent does
    // not report" — an agent built before the field existed sends nothing, and
    // must not silently clear the rows a newer one wrote. An empty array is the
    // opposite statement, "I hold nothing failing", and DOES clear them.
    if (Array.isArray(body.processes)) {
      // Failing here must not fail the sync. What the node needs from this
      // response is `apps`; a node that stops receiving desired state because a
      // status write failed is a worse outcome than a stale fault row, and this
      // channel exists to prevent an outage rather than to cause one.
      await recordNodeFaults(name, body.processes as ProcessFault[]).catch((e) => {
        console.error("fleet sync: recording faults for", name, e instanceof Error ? e.message : String(e));
      });
    }
    // The positive half, on the same absent-vs-empty rule and independent of the
    // one above: an agent may report either, both or neither, and one arriving
    // must never be read as a statement about the other. Absent leaves the rows
    // alone — an agent built before this field existed says nothing about what it
    // runs, and a worker-only deploy against one correctly finds no rows and
    // rolls back rather than flipping on faith.
    if (Array.isArray(body.running)) {
      // Swallowed for the same reason: what the node needs from this response is
      // `apps`, and a node that stops receiving desired state because a status
      // write failed is a worse outcome than a stale row. The verdict this feeds
      // fails closed, so a missed write costs a rolled-back deploy, never a
      // wrongly passed one.
      // Which apps have data, from the only vantage point that can see it. Guarded
      // on the field being present: absent means an agent that does not report it,
      // and taking that as "nothing has data" would unpin every app on the node
      // and let the reconciler move a database away from its disk.
      if (Array.isArray(body.withData)) {
        await recordDataUse(name, (body.withData as unknown[]).filter((s): s is string => typeof s === "string"))
          .catch((e) => {
            console.error("fleet sync: recording data use for", name, e instanceof Error ? e.message : String(e));
          });
      }
      await recordNodeRunning(name, body.running as ProcessState[]).catch((e) => {
        console.error("fleet sync: recording running for", name, e instanceof Error ? e.message : String(e));
      });
      // And the placement's own state, promoted on the sync that confirmed it
      // rather than on the reconciler's clock. A rollout will not drain the old
      // instance until the new one is `ready`, so waiting for the next pass
      // would add up to a minute to every rollout for nothing — and until this
      // existed, nothing wrote that field at all and a rollout stopped forever
      // one instance in.
      await promoteReady(name, (body.running as ProcessState[]).map((r) => ({
        slug: r.slug, image: r.image, healthy: r.healthy ?? undefined,
      }))).catch((e) => {
        console.error("fleet sync: promoting for", name, e instanceof Error ? e.message : String(e));
      });
    }

    // This node just spoke, so everything it holds keeps its lease. This is what
    // makes the lease mean anything: a node that is talking keeps its
    // placements, and one that stops loses them to the control plane's
    // arithmetic — never to any instruction of its own, which is why the node
    // goes on serving through an outage of this endpoint.
    await renewLeases(name).catch((e) => {
      // Never fail the sync over it. A lease that could not be renewed costs at
      // most one reconcile pass deciding to move an app that is fine; a sync
      // that fails costs the node its desired state.
      console.error("fleet sync: renewing leases for", name, e instanceof Error ? e.message : String(e));
    });

    // The generation is read BEFORE the desired state, and the order is the
    // whole correctness argument.
    //
    // Read this way, a placement landing between the two reads gives the node
    // newer data carrying an older generation: it refetches on its next poll and
    // receives the same thing, which costs one redundant payload. Read the other
    // way round, the node would get older data carrying a NEWER generation, stop
    // asking, and stay stale until something unrelated moved the counter — a
    // deploy that reported success and never reached the machine.
    //
    // One ordering costs a wasted request. The other loses a deploy.
    const current = await fleetGeneration();
    const decision = decideSync(
      typeof body.generation === "number" ? body.generation : undefined,
      current,
    );
    if (!decision.send) {
      // Nothing has changed since this node last asked. It keeps what it has,
      // which is the same set it would have been sent — so this is a smaller
      // answer to the same question, not a different one.
      return Response.json({ generation: decision.generation, unchanged: true });
    }

    const apps = await desiredFor(name);
    // Where everything else lives. Without this a second node is not more
    // capacity, it is an outage for half of every app's traffic: the load
    // balancer fans across nodes without knowing where anything is, and the one
    // that does not hold an app answers `Not on this node`.
    const peers = await peersFor(name).catch((e) => {
      // A peer map we could not read is a node that forwards nothing, which is
      // exactly today's behaviour. It must never cost the node its own apps.
      console.error("fleet sync: peers for", name, e instanceof Error ? e.message : String(e));
      return [];
    });
    // Which of this node's apps are being drained. The node keeps RUNNING them —
    // they are still in `apps` — and stops offering them a local route, so the
    // load balancer reaching this machine is sent on to the version that
    // replaced them instead of being served the one on its way out.
    //
    // Best-effort like `peers`: a list that cannot be read costs the promptness
    // of a drain, not the node's ability to serve.
    const draining = await drainingOn(name).catch((e) => {
      console.error("fleet sync: draining for", name, e instanceof Error ? e.message : String(e));
      return [] as string[];
    });
    return Response.json({ generation: decision.generation, apps, peers, draining });
  } catch (e) {
    // A node that gets an error here keeps running what it already has, which is
    // the correct failure: the cached desired state is still the last thing the
    // control plane actually said.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("fleet sync:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
