export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentAdminEmail } from "@/lib/admin";
import { readFleetStatus } from "@/lib/fleet-status";

/**
 * What the fleet holds, for an operator who cannot ssh to it.
 *
 * Read-only, and there is no companion that is not: no restart, no re-place, no
 * drain. A control action here would have to reach the node, and the node is
 * deliberately never pushed to — it pulls, which is the whole availability story
 * (lib/fleet.ts). Anything that changes placement belongs on the deploy path
 * where the rollback lives.
 *
 * Under /api/admin rather than beside /api/fleet/sync on purpose. That namespace
 * is the node's, authenticated by the shared FLEET_TOKEN; this is a person's,
 * authenticated by the operator allowlist. Two different secrets guarding two
 * different questions should not share a path prefix, because the next route
 * added under it inherits whichever gate the neighbour had.
 *
 * A caller who is not an operator gets 404 and NOT 403: there is no reason to
 * confirm to a stranger that a page listing every tenant's app exists. Same
 * choice `app/admin/analytics/page.tsx` makes, and the same gate —
 * `currentAdminEmail`, which is the sign-in allowlist's own matcher over a
 * separate table (lib/admin.ts). Not a second mechanism.
 *
 * The gate runs BEFORE the read, so an unauthenticated request costs production
 * no database work at all — the reason test/admin-fleet-route.test.ts asserts
 * the reader was never called rather than asserting the body is empty, which it
 * would be regardless.
 */
export async function GET() {
  if (!(await currentAdminEmail())) return new Response(null, { status: 404 });

  const snapshot = await readFleetStatus();
  // A failed read is a 500 as well as a named message. A client that only checks
  // the status must not read "we could not ask" as "nothing is failing".
  return Response.json(snapshot, { status: snapshot.ok ? 200 : 500 });
}
