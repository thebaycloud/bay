export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { heartbeatNode, desiredFor, recordNodeFaults, type NodeReport, type ProcessFault } from "@/lib/fleet";

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

  let body: Partial<NodeReport> & { processes?: unknown };
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

    const apps = await desiredFor(name);
    return Response.json({ apps });
  } catch (e) {
    // A node that gets an error here keeps running what it already has, which is
    // the correct failure: the cached desired state is still the last thing the
    // control plane actually said.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("fleet sync:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
