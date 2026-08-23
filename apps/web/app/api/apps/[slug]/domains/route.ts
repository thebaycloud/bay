export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug } from "@/lib/apps";
import { currentUserId } from "@/lib/session";
import { entitlement } from "@/lib/entitlements";
import { customDomainMessage } from "@/lib/plan-copy";
import {
  attachDomain, detachDomain, getDomain, listDomains, recordDomain,
  normalizeHostname, refuseHostname, MAX_DOMAINS_PER_APP, type AppDomain,
} from "@/lib/domains";
import { reconcileAll, reconcileDomain, liveAttachDeps } from "@/lib/domain-attach";
import { removeDomainCert, EDGE_IP } from "@/lib/domain-cert";
import { rootDomain } from "@/lib/roots";
import { recordFor } from "@/lib/dns-record";

/**
 * The domains attached to one app: read them, attach one, detach one.
 *
 * Owner-only, on the app row rather than on a Cloud Run label — this route has
 * no legacy shape to be compatible with, so it asks the one authoritative
 * question and refuses everything else.
 */
async function ownedApp(slug: string) {
  const uid = await currentUserId();
  if (!uid) return null;
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return null;
  return app;
}

/**
 * What the dashboard needs to draw a domain, and nothing else.
 *
 * `cert_id` and `entry_id` are deliberately not here. They name resources in our
 * Google project; they are ours, they mean nothing to the person, and a field a
 * page does not use is a field that leaks the day someone logs the payload.
 */
function forPage(d: AppDomain, dns: { ip: string; cname: string }) {
  return {
    hostname: d.hostname,
    status: d.status,
    detail: d.detail,
    checkedAt: d.checkedAt,
    createdAt: d.createdAt,
    liveAt: d.liveAt,
    // The one record to create for THIS hostname, decided here.
    //
    // The dashboard computes it in the browser from `dns` and `lib/dns-record`,
    // and could go on doing that alone — but the CLI cannot. It would have to
    // carry its own copy of the apex-versus-subdomain rule, and that copy would
    // agree on the day it was written and disagree the first time the two-level
    // suffix list grows: a person told to create a CNAME at an apex, by us, for
    // a domain their registrar will refuse. One rule, one file, sent to whoever
    // asks.
    record: recordFor(d.hostname, dns),
  };
}

/**
 * The records a person has to create, said the same way every time.
 *
 * Both are offered because neither works everywhere: an apex (`acme.com`) cannot
 * be a CNAME — the DNS specification forbids it beside the zone's own SOA and NS
 * records — and a subdomain is better as a CNAME, because it keeps working if
 * our load balancer's address ever changes.
 */
function dnsInstructions(slug: string) {
  return {
    ip: EDGE_IP,
    // The CANONICAL root, always. Handing out a CNAME at a root we are retiring
    // would have somebody point their own DNS at a name that 301s — a redirect
    // loop on their domain, created by following our instructions.
    cname: `${slug}.${rootDomain()}`,
  };
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403 });

  // Reading the list is also what advances it. See lib/domain-attach.ts: there
  // is no worker, and `dueForCheck` keeps a page that polls from turning into a
  // load generator.
  const domains = await reconcileAll(await listDomains(slug));
  const ent = await entitlement(app.owner_id);
  const dns = dnsInstructions(slug);
  return Response.json({
    domains: domains.map((d) => forPage(d, dns)),
    dns,
    allowed: ent.limits.customDomains,
    // A private app cannot answer for a custom domain the way it answers for its
    // supersonic.cv address: the session cookie that proves who a visitor is is
    // scoped to `.supersonic.cv` and a browser will not send it to acme.com. The
    // edge sends those requests back to the platform address, and the page says
    // so before a person attaches rather than after.
    visibility: app.visibility,
  });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403 });

  const ent = await entitlement(app.owner_id);
  if (!ent.limits.customDomains) {
    return Response.json({ error: customDomainMessage() }, { status: 402 });
  }

  const body = await req.json().catch(() => ({}));
  const hostname = normalizeHostname(String(body.hostname ?? ""));
  if (!hostname) {
    return Response.json({ error: "that does not look like a domain name" }, { status: 400 });
  }
  const refused = refuseHostname(hostname);
  if (refused) return Response.json({ error: refused }, { status: 400 });

  // Counted before the insert, and only for a hostname this app does not already
  // have — re-adding one it holds is idempotent and must not be refused by a cap
  // it already occupies.
  const held = await listDomains(slug);
  if (held.length >= MAX_DOMAINS_PER_APP && !held.some((d) => d.hostname === hostname)) {
    return Response.json(
      { error: `An app can hold ${MAX_DOMAINS_PER_APP} domains. Remove one to add another.` },
      { status: 409 }
    );
  }

  const attached = await attachDomain(slug, hostname);
  if (!attached.ok) {
    if (attached.taken) {
      return Response.json(
        { error: `${hostname} is already connected to an app. Remove it there first.` },
        { status: 409 }
      );
    }
    return Response.json({ error: attached.why }, { status: 400 });
  }

  // One look immediately, so the answer names the state the person is actually
  // in. Nearly always `pending_dns` — they have not created the record yet,
  // because this page is where it is written down — but a person moving a domain
  // that already points here sees `securing` on the first response instead of a
  // spinner that resolves ten seconds later.
  const next = await reconcileDomain(attached.domain, liveAttachDeps);
  await recordDomain(hostname, next);

  const dns = dnsInstructions(slug);
  return Response.json({
    domain: forPage({
      ...attached.domain,
      status: next.status,
      detail: next.detail,
      checkedAt: Date.now(),
      liveAt: next.status === "live" ? Date.now() : attached.domain.liveAt,
    }, dns),
    dns,
  });
}

export async function DELETE(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403 });

  const hostname = normalizeHostname(new URL(req.url).searchParams.get("hostname") ?? "");
  if (!hostname) return Response.json({ error: "which domain?" }, { status: 400 });

  const domain = await getDomain(hostname);
  // Not "no such domain": a hostname attached to somebody else's app is not this
  // owner's to hear about. Both answers are the same 404.
  if (!domain || domain.slug !== slug) return Response.json({ error: "not attached" }, { status: 404 });

  // Google first, us second. The row is what the edge reads to serve the name,
  // so deleting it first would leave a hostname on the load balancer with a
  // valid certificate and nothing behind it — a working TLS handshake onto a
  // 404, which looks like the platform losing the app rather than the domain
  // having been removed.
  const torn = await removeDomainCert(domain.certId, domain.entryId);
  if (!torn.ok) return Response.json({ error: torn.why }, { status: 502 });

  await detachDomain(hostname);
  return Response.json({ ok: true });
}
