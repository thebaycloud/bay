import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const IDENTITY_PREFIX = "x-supersonic-";
/**
 * Anything the client sent under `x-forwarded-` is discarded here, before we
 * write our own, because this proxy is the trust boundary and a browser is on
 * the other side of it. A visitor who sends `x-forwarded-host: evil.com` would
 * otherwise decide where an app's OAuth `redirect_uri` and password-reset links
 * point; `x-forwarded-proto: http` would talk an app out of https. Those are
 * overwritten rather than appended to, so no visitor-chosen value survives as the
 * first element of a list an app reads leftmost-first.
 *
 * `for` is the deliberate asymmetry, and it is not an exception to the rule.
 * Proto, host and prefix are statements about US — where we terminate TLS and
 * where we mounted the service — so we are the only honest source and anything
 * arriving in those fields is noise at best. The client's IP is the opposite: it
 * is the one fact in the request we cannot observe ourselves, because the peer on
 * our socket is Google's load balancer. That balancer rewrites the chain and
 * appends the address IT saw the connection come from, after whatever the client
 * supplied — so the last element was written by the LB, not by the client, and a
 * spoofed entry can only ever sit to the left of it. We take that last element
 * and pass on nothing else. Apps need it: rate limiting, abuse blocking, geo and
 * audit logs all fail closed or fail silently without it, and an app that is
 * handed none has no way to recover it.
 *
 * If a hop is ever added between the LB and this proxy, this is the line that
 * has to change.
 */
const FORWARDED_PREFIX = "x-forwarded-";
/** Hop-by-hop headers plus Host, which the upstream request sets itself. */
const DROP = new Set([
  // Host stays dropped even now that we know it matters. The upstream is a
  // shared Cloud Run frontend that selects a service BY Host, so a request
  // arriving at web-xyz.a.run.app carrying `Host: hello.supersonic.cv` is 404'd
  // by Google before the container is ever reached. x-forwarded-host below
  // carries the client-facing name that the app has to put in its own URLs.
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  // `authorization` is deliberately NOT dropped outright. It used to be,
  // because the invoker token for Cloud Run was written into that same slot —
  // so the app's own credentials were destroyed to make room for ours, and any
  // app authenticating with a bearer token appeared to log its users out the
  // instant they signed in. The invoker token moved to x-serverless-authorization
  // (see forward.ts) and this header now belongs to the visitor again.
  //
  // Ours must still never leak the other way: a token minted for one app's
  // audience is stripped on the way back, not passed to another upstream. The
  // same is true of a platform token arriving IN this header: an agent's `ss_`
  // CLI token (see session.ts's platformTokenFrom, which resolves it at the
  // edge) is a full platform identity — apps/web/lib/session.ts accepts it as
  // currentUserId — so forwarding it verbatim would hand that credential to
  // whichever tenant app it was addressed to, in that app's own request logs.
  // Stripped by shape (PLATFORM_BEARER below), not by key, because only some
  // Authorization values are ours; an app's own bearer must still reach it
  // untouched, which is the whole point of not dropping this header at all.
  "x-serverless-authorization",
  // RFC 7239's header, dropped for the same reason as the x-forwarded-* family.
  "forwarded",
  // Dropped so upstream HTML comes back uncompressed and we can inject the
  // Supersonic badge/toolbar before </body> without decoding gzip/br.
  "accept-encoding",
]);

// A host arrives from the client and is spliced into `forwarded`, so it is
// checked against what a host may actually contain — a name or an IP, with an
// optional port. Anything else is dropped rather than repaired: a value with a
// ";" in it would silently add parameters to the header we build.
const HOST = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
// Prefixes come from the app's own routes, not from the request, so this only
// has to stop junk in the database from reaching the wire.
const PREFIX = /^\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*$/;
// v4, or v6 in any of its spellings. Same reason as HOST: this ends up inside
// `forwarded`, so it is checked before it is spliced, never repaired.
const CLIENT_IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:.]{2,45})$/;
// A platform CLI token, shaped `Bearer ss_...` — the same shape session.ts's
// platformTokenFrom resolves at the edge. Duplicated rather than imported: that
// module pulls in config.ts, which throws at import time without AUTH_SECRET,
// and this one has no business acquiring that requirement just to recognise a
// prefix. If the prefix ever changes, change it in both places.
const PLATFORM_BEARER = /^bearer\s+ss_\S+\s*$/i;

export interface VisitorIdentity { userId: string; email: string; name: string }

/** Remove the Supersonic session cookie from a Cookie header value. */
export function stripSessionCookie(value: string, cookieName: string): string {
  return value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith(cookieName + "="))
    .join("; ");
}

/** The client-facing host, or null if there wasn't a usable one to forward. */
function clientHost(incoming: IncomingHttpHeaders): string | null {
  const raw = incoming.host;
  const host = Array.isArray(raw) ? raw[0] : raw;
  return host && HOST.test(host) ? host : null;
}

/**
 * The address the load balancer saw the connection come from: the last element
 * of the inbound chain, which is the one the LB appended and the only one a
 * client cannot have written. Everything to its left is dropped.
 */
function clientIp(incoming: IncomingHttpHeaders): string | null {
  const raw = incoming["x-forwarded-for"];
  const chain = Array.isArray(raw) ? raw.join(",") : raw;
  if (!chain) return null;
  const last = (chain.split(",").pop() ?? "").trim();
  return CLIENT_IP.test(last) ? last : null;
}

/** "/api" for a service mounted there, null for one that owns "/". */
function mountPrefix(prefix: string | null | undefined): string | null {
  if (!prefix || !PREFIX.test(prefix)) return null;
  const p = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return p === "/" ? null : p;
}

export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  visitor: VisitorIdentity,
  sessionCookieName: string,
  slug?: string,
  prefix?: string | null
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};

  for (const [rawKey, value] of Object.entries(incoming)) {
    const key = rawKey.toLowerCase();
    if (DROP.has(key)) continue;
    // Anything the client sent under our prefix is discarded unconditionally.
    if (key.startsWith(IDENTITY_PREFIX)) continue;
    if (key.startsWith(FORWARDED_PREFIX)) continue;
    if (key === "cookie") {
      const kept = stripSessionCookie(String(value ?? ""), sessionCookieName);
      if (kept) out.cookie = kept;
      continue;
    }
    if (key === "authorization") {
      // See the note above DROP: this is the one shape of Authorization that
      // does not belong to the visitor, so it is the one that does not survive.
      const raw = Array.isArray(value) ? value[0] : value;
      if (raw && PLATFORM_BEARER.test(raw)) continue;
      if (raw !== undefined) out.authorization = raw;
      continue;
    }
    out[key] = value;
  }

  out["x-supersonic-user-id"] = visitor.userId;
  out["x-supersonic-email"] = visitor.email;
  out["x-supersonic-name"] = visitor.name;
  // Host is dropped above and the upstream request sets its own, so an upstream
  // shared between tenants — the static server fronting every static app — has
  // no way to tell which app a request was for. This is that way. Safe to trust
  // downstream precisely because the loop above discards anything the client
  // sent under this prefix.
  if (slug) out["x-supersonic-slug"] = slug;

  // Where the request actually came from. Nothing else tells the app: it is
  // handed a plain http connection from a Cloud Run hostname it has never heard
  // of, and every absolute URL it derives from that is wrong — OAuth
  // redirect_uri, password-reset links, Set-Cookie Domain, canonical tags,
  // sitemaps, request.build_absolute_uri(). Django with SECURE_SSL_REDIRECT
  // redirects to https forever, because after the redirect the request still
  // looks like http to it; without a matching ALLOWED_HOSTS it 400s instead.
  const host = clientHost(incoming);
  if (host) out["x-forwarded-host"] = host;
  // Unconditionally https: every hop a browser makes to us terminates TLS, and
  // the plaintext hop from here to the container is ours and not the visitor's.
  out["x-forwarded-proto"] = "https";
  // Set only for a service that really is mounted under a prefix. Handing "/" to
  // an app that owns "/" makes Django's FORCE_SCRIPT_NAME emit "//about" and
  // Next's basePath refuse to build.
  const mount = mountPrefix(prefix);
  if (mount) out["x-forwarded-prefix"] = mount;
  // The one field we relay instead of asserting — see FORWARDED_PREFIX above.
  // Single-valued, because the app has no way to tell which element of a chain we
  // vouched for, and a chain invites it to read the leftmost one a visitor wrote.
  const ip = clientIp(incoming);
  if (ip) out["x-forwarded-for"] = ip;
  // RFC 7239's standard spelling of the same facts, for the frameworks that read
  // it instead (Rack, recent Spring, Werkzeug's ProxyFix in trust-forwarded
  // mode). The host is quoted when it carries a port, because ":" is not allowed
  // in a bare token and an unquoted "host=app.local:8080" is a parse error, not
  // a value the app ignores. An IPv6 `for` needs both brackets and quotes for the
  // same reason — RFC 7239 §6 spells it `for="[2001:db8::1]"`.
  const quotedHost = host && host.includes(":") ? `"${host}"` : host;
  const quotedIp = ip && ip.includes(":") ? `"[${ip}]"` : ip;
  out.forwarded = [
    quotedIp && `for=${quotedIp}`,
    quotedHost && `host=${quotedHost}`,
    "proto=https",
  ].filter(Boolean).join(";");
  return out;
}

/**
 * Hop-by-hop headers describe one connection and must never be copied onto
 * another. `transfer-encoding` is the one that bites: an upstream that streams
 * HTML sends `chunked`, and when we buffer that response to inject the overlay we
 * set our own `content-length`. Forwarding both makes a response the load
 * balancer rejects outright — "protocol error", a 502 the app never sees and
 * cannot explain.
 */
const RESPONSE_DROP = new Set([
  "transfer-encoding", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "upgrade",
]);

export function stripHopByHop(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  for (const key of Object.keys(headers)) {
    if (RESPONSE_DROP.has(key.toLowerCase())) delete headers[key];
  }
  return headers;
}

/** Drop Domain= from upstream cookies so one tool cannot set a cookie for another. */
export function scrubSetCookie(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const raw = headers["set-cookie"];
  if (!raw) return headers;
  const list = Array.isArray(raw) ? raw : [String(raw)];
  headers["set-cookie"] = list.map((c) =>
    c
      .split(";")
      .map((p) => p.trim())
      // Index 0 is the cookie's own name=value pair, so a cookie literally
      // named "domain" must survive; only later segments are attributes.
      .filter((p, i) => i === 0 || !/^domain=/i.test(p))
      .join("; ")
  );
  return headers;
}
