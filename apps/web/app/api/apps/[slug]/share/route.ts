export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { forbiddenBody } from "@/lib/api-error";
import {
  getAppBySlug, setVisibility,
  listGrants, addGrant, removeGrant,
  listDomainGrants, addDomainGrant, removeDomainGrant, workspaceDomainOfApp,
  type Visibility,
} from "@/lib/apps";
import { listPending, resolveRequest } from "@/lib/requests";
import { profilesFor } from "@/lib/users";
import { sendAccessGranted } from "@/lib/emails";
import { currentUserId } from "@/lib/session";
import { entitlement, countPublicApps } from "@/lib/entitlements";
import { publicLimitMessage, noAccountMessage } from "@/lib/plan-copy";
import { normalizeDomain, isPublicEmailProvider } from "@/lib/workspace";
import { corsFor, optionsHandler } from "@/lib/cors";

const VISIBILITIES: Visibility[] = ["private", "shared", "public"];

// The drawer edits access from <slug>.supersonic.cv, a different origin than
// app.supersonic.cv. This used to allow ANY *.supersonic.cv origin, which is
// every tenant's own JavaScript — see lib/cors.ts for the cross-tenant CSRF
// that permits and why the allowlist is now this app's origin alone.
export const OPTIONS = optionsHandler;

async function ownedApp(slug: string) {
  const uid = await currentUserId();
  if (!uid) return null;
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return null;
  return app;
}

/**
 * Everything the panel draws, in one shape, so GET and POST cannot drift.
 *
 * `workspaceDomain` is the owner's own company domain (null for a personal
 * account), and it is here for the one-click suggestion — "everyone at acme.com"
 * is the rule people mean nine times out of ten, and typing it out is the part
 * they get wrong.
 */
async function state(slug: string, visibility: Visibility | undefined) {
  const [grants, domains, requests, workspaceDomain] = await Promise.all([
    listGrants(slug), listDomainGrants(slug), listPending(slug), workspaceDomainOfApp(slug),
  ]);
  // The name and face behind each address, for the panel to draw. Every one of
  // these is somebody the owner invited, and this route is owner-only — it is not
  // a lookup that would answer "is this person on the platform" about an address
  // the caller has not already been shown.
  //
  // Absent for an invited address that has never signed in, and for a password
  // account, which has no picture. The panel draws initials then, which is the
  // truth rather than a placeholder for something we could have had.
  const profiles = await profilesFor([...grants, ...requests]);
  const person = (email: string) => ({
    email,
    name: profiles.get(email)?.name ?? null,
    image: profiles.get(email)?.image ?? null,
  });
  return {
    visibility,
    domains,
    workspaceDomain,
    // Both shapes. `grants` and `requests` stay as plain string arrays because
    // the CLI and the app's own drawer read them; `people` and `waiting` carry
    // the same addresses with a name and a face on them.
    grants,
    requests,
    people: grants.map(person),
    waiting: requests.map(person),
  };
}

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const cors = corsFor(req, slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json(forbiddenBody(), { status: 403, headers: cors });
  return Response.json(await state(slug, app.visibility), { headers: cors });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const cors = corsFor(req, slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json(forbiddenBody(), { status: 403, headers: cors });

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
    await sendAccessGranted({ email, slug });
  }
  if (body.addDomain) {
    const domain = normalizeDomain(String(body.addDomain));
    if (!domain) {
      return Response.json({ error: "that isn't a domain" }, { status: 400, headers: cors });
    }
    // A consumer provider is not an organisation. A rule for gmail.com admits
    // everybody with a browser, which is `public` — and `public` is the one
    // visibility that is counted, capped, and says so on the app. Letting it be
    // spelled as a domain rule would route around all three.
    if (isPublicEmailProvider(domain)) {
      return Response.json(
        { error: `${domain} is everyone's address, not an organisation. Choose Public if you mean anyone.` },
        { status: 400, headers: cors }
      );
    }
    const ent = await entitlement(app.owner_id);
    if (ent.locked) {
      return Response.json({ error: noAccountMessage(), paywall: true, reason: "no_account" }, { status: 402, headers: cors });
    }
    // No email is sent: a rule has no recipient. The people it admits find out
    // by opening the link, which is the whole point of a rule over an invite.
    await addDomainGrant(slug, domain);
  }
  if (body.removeEmail) await removeGrant(slug, String(body.removeEmail));
  // Normalised on the way out too, so removing a rule shown as "@acme.com"
  // deletes the row stored as "acme.com".
  if (body.removeDomain) {
    const domain = normalizeDomain(String(body.removeDomain));
    if (domain) await removeDomainGrant(slug, domain);
  }
  if (body.denyEmail) await resolveRequest(slug, String(body.denyEmail), "denied");

  const fresh = await getAppBySlug(slug);
  return Response.json(await state(slug, fresh?.visibility), { headers: cors });
}
