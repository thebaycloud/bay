export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { reconcileOnce } from "@/lib/reconcile";

/**
 * One reconcile pass, on demand.
 *
 * The control plane has had no periodic process of any kind — no cron, no
 * worker, no interval — so it was entirely reactive and acted only when a deploy
 * arrived. A node that died at night took its apps with it until somebody
 * redeployed them by hand, while `chooseNode` went on deliberately leaving
 * headroom on every node so that one could absorb another's. The policy was
 * there and the mechanism was not.
 *
 * AN ENDPOINT RATHER THAN A LOOP, and the reason is where this runs. A Cloud Run
 * Job on a schedule pays a hundred seconds of cold start per pass, measured, for
 * work that takes milliseconds. A `setInterval` inside Next.js runs once per
 * instance, and this service is not pinned to one. An endpoint plus a scheduler
 * is the one shape that is correct on this runtime — and the pass takes an
 * advisory lock anyway, so two callers cannot both act.
 *
 * Authorised with the same token the nodes use. This mutates placements, which
 * is the most consequential thing in the system to leave open.
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
  if (!authorised(req)) return Response.json({ error: "unauthorised" }, { status: 401 });
  try {
    const result = await reconcileOnce();
    // A pass that could not take the lock is not an error: another one is
    // already doing the work, and the honest report is that this one had
    // nothing to do rather than that something failed.
    if (!result) return Response.json({ skipped: "another pass holds the lock" });
    // `held` is reported separately from `steps` because a holding pass and a
    // quiet pass both show zero steps and are not the same thing — one fleet is
    // fine and the other has an expired lease the control plane is deliberately
    // refusing to act on.
    if (result.held) {
      console.error(`reconcile: holding ${result.held} app(s) with an expired lease — no quorum over ${result.apps} apps`);
    }
    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("reconcile:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
