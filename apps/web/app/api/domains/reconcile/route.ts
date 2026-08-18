export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { unsettledDomains } from "@/lib/domains";
import { reconcileAll } from "@/lib/domain-attach";

/**
 * One sweep over every domain that has not settled yet.
 *
 * WHY THIS EXISTS, and it is not a design that was planned: attaching a domain
 * used to advance only while somebody had the settings page open, because the
 * page's own poll was the only thing that ever called the reconcile. That reads
 * fine in a diagram and fails on the first real attachment. What happened on
 * 18 Aug with `arsen.wtf`: the person added the domain, saw "waiting for your
 * DNS" because their record was still the registrar's parking IP, went and fixed
 * the record — and closed the page. Nothing looked again. The domain resolved to
 * us, the app answered its 404, and the dashboard went on saying "waiting for
 * your DNS" indefinitely. Every part of that was working as written; the part
 * that was missing had nobody to write it.
 *
 * So the loop that carries a domain forward cannot be the page. The page is now
 * what makes it FAST while somebody is watching, and this is what makes it
 * happen at all.
 *
 * An endpoint on a schedule rather than an interval, for exactly the reasons
 * `api/fleet/reconcile` gives: a `setInterval` inside Next.js runs once per
 * instance and this service is not pinned to one, and a Cloud Run Job per pass
 * pays a cold start for work that takes milliseconds.
 *
 * Idempotent and safe to overlap. `dueForCheck` throttles each row, every step
 * underneath is a create-if-absent, and two passes racing on one hostname write
 * the same answer.
 */
function authorised(req: Request): boolean {
  // The same token the fleet endpoint uses — the one credential that means "an
  // internal caller", not "a person". A second secret to rotate would buy
  // nothing here: this endpoint mutates no placement and returns no tenant data,
  // it only writes down what DNS and Google already say in public.
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
  const before = await unsettledDomains();
  const after = await reconcileAll(before);
  // What MOVED, not how many were looked at. A pass that checks nine domains and
  // changes none is the normal case and should read as quiet; a pass that
  // changed one is the interesting line in the log.
  const moved = after.filter((d, i) => d.status !== before[i].status);
  if (moved.length) {
    for (const d of moved) console.log(`domains: ${d.hostname} is now ${d.status}${d.detail ? ` (${d.detail})` : ""}`);
  }
  return Response.json({
    looked: before.length,
    moved: moved.map((d) => ({ hostname: d.hostname, status: d.status })),
  });
}
