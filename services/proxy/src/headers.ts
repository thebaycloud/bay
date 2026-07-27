import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const IDENTITY_PREFIX = "x-supersonic-";
/** Hop-by-hop headers plus Host, which the upstream request sets itself. */
const DROP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "authorization",
  // Dropped so upstream HTML comes back uncompressed and we can inject the
  // Supersonic badge/toolbar before </body> without decoding gzip/br.
  "accept-encoding",
]);

export interface VisitorIdentity { userId: string; email: string; name: string }

/** Remove the Supersonic session cookie from a Cookie header value. */
export function stripSessionCookie(value: string, cookieName: string): string {
  return value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith(cookieName + "="))
    .join("; ");
}

export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  visitor: VisitorIdentity,
  sessionCookieName: string
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};

  for (const [rawKey, value] of Object.entries(incoming)) {
    const key = rawKey.toLowerCase();
    if (DROP.has(key)) continue;
    // Anything the client sent under our prefix is discarded unconditionally.
    if (key.startsWith(IDENTITY_PREFIX)) continue;
    if (key === "cookie") {
      const kept = stripSessionCookie(String(value ?? ""), sessionCookieName);
      if (kept) out.cookie = kept;
      continue;
    }
    out[key] = value;
  }

  out["x-supersonic-user-id"] = visitor.userId;
  out["x-supersonic-email"] = visitor.email;
  out["x-supersonic-name"] = visitor.name;
  return out;
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
