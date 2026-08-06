export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug, setVisibility, listGrants, addGrant, removeGrant, type Visibility } from "@/lib/apps";
import { listPending, resolveRequest } from "@/lib/requests";
import { sendAccessGranted } from "@/lib/email";
import { currentUserId } from "@/lib/session";
import { entitlement, countPublicApps } from "@/lib/entitlements";
import { publicLimitMessage, noAccountMessage } from "@/lib/plan-copy";

const VISIBILITIES: Visibility[] = ["private", "shared", "public"];

// The injected toolbar edits access from <slug>.supersonic.cv (a different origin
// than app.supersonic.cv), so allow credentialed cross-origin calls from our own
// subdomains — and only those.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  try {
    const h = new URL(origin).hostname;
    if (h === "supersonic.cv" || h.endsWith(".supersonic.cv")) {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      };
    }
  } catch { /* no/invalid origin — same-origin call, no CORS headers needed */ }
  return {};
}

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

async function ownedApp(slug: string) {
  const uid = await currentUserId();
  if (!uid) return null;
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return null;
  return app;
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const cors = corsHeaders(req);
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403, headers: cors });
  const [grants, requests] = await Promise.all([listGrants(slug), listPending(slug)]);
  return Response.json({ visibility: app.visibility, grants, requests }, { headers: cors });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const cors = corsHeaders(req);
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403, headers: cors });

  const body = await req.json().catch(() => ({}));

  if (body.visibility) {
    if (!VISIBILITIES.includes(body.visibility)) {
      return Response.json({ error: "invalid visibility" }, { status: 400, headers: cors });
    }
    // The public cap, and the only limit on this route that still bites —
    // sharing by email is unlimited on every plan.
    //
    // Only 'public' is counted. Private and email-shared apps are unbounded
    // because they are the product working; public is bounded because it is the
    // one visibility a stranger can reach, which makes it both the acquisition
    // surface and the abuse surface (free CDN, phishing host, raw egress).
    //
    // `countPublicApps` excludes this slug, so re-saving an app that is already
    // public is idempotent rather than a refusal against the cap it occupies.
    if (body.visibility === "public") {
      const ent = await entitlement(app.owner_id);
      if (Number.isFinite(ent.limits.maxPublicApps)) {
        const others = await countPublicApps(app.owner_id, slug);
        if (others >= ent.limits.maxPublicApps) {
          return Response.json(
            { error: publicLimitMessage(ent.limits), upgrade: true, reason: "public_limit" },
            { status: 402, headers: cors }
          );
        }
      }
    }
    await setVisibility(slug, body.visibility);
  }
  if (body.addEmail) {
    const email = String(body.addEmail).trim().toLowerCase();
    // 254 is the maximum length of an address per RFC 5321; without a bound an
    // arbitrarily long string matches the regex and reaches the database.
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: "invalid email" }, { status: 400, headers: cors });
    }
    // Sharing by email is unlimited on every plan — `maxGrants` is Infinity
    // everywhere, so the cap below never fires. It is kept rather than deleted
    // because the mechanism is worth having if a spam vector ever appears here;
    // what is NOT worth having is a number in it, because recipients are how
    // small software spreads and charging for them taxes our own growth.
    const ent = await entitlement(app.owner_id);
    if (ent.locked) {
      return Response.json({ error: noAccountMessage(), paywall: true, reason: "no_account" }, { status: 402, headers: cors });
    }
    if (Number.isFinite(ent.limits.maxGrants)) {
      const current = await listGrants(slug);
      if (!current.includes(email) && current.length >= ent.limits.maxGrants) {
        return Response.json(
          { error: `Your plan allows sharing with ${ent.limits.maxGrants} people. Upgrade to Pro for unlimited sharing.`, upgrade: true },
          { status: 402, headers: cors }
        );
      }
    }
    // Granting = inviting or approving a request; either way, resolve any pending
    // request and tell the person they're in.
    await addGrant(slug, email);
    await resolveRequest(slug, email, "approved");
    await sendAccessGranted(email, slug);
  }
  if (body.removeEmail) await removeGrant(slug, String(body.removeEmail));
  if (body.denyEmail) await resolveRequest(slug, String(body.denyEmail), "denied");

  const fresh = await getAppBySlug(slug);
  const [grants, requests] = await Promise.all([listGrants(slug), listPending(slug)]);
  return Response.json({ visibility: fresh?.visibility, grants, requests }, { headers: cors });
}
