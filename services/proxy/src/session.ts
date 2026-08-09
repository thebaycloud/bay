import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { decode } from "@auth/core/jwt";
import { config } from "./config";
import { db } from "./db";

export interface Visitor { userId: string; email: string; name: string }

/**
 * One Visitor, whichever door the person came through.
 *
 * Both paths call this, which is the only way the promise below — that nothing
 * downstream learns which was used — can actually hold. The email is lowercased
 * because it does not stay here: forward.ts sends it to the tenant app as
 * `x-supersonic-email`, and an app keying accounts on that header saw the same
 * human as `Ada@Example.com` from their agent and `ada@example.com` from their
 * browser, and made them two people. The same value is also what `hasGrant`
 * matches a shared app's invitations against.
 */
export function oneVisitor(userId: unknown, email: unknown, name: unknown): Visitor {
  return {
    userId: String(userId ?? ""),
    email: String(email ?? "").toLowerCase(),
    name: String(name ?? ""),
  };
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Platform tokens are minted `"ss_" + randomBytes(24).toString("base64url")`
 * (apps/web/lib/cli-tokens.ts) — this prefix is the only thing that tells a
 * platform credential apart from a bearer token an app issues its own users.
 * It has to be checked: a private or shared app's own frontend regularly calls
 * its own API with its own JWT under this same header (see headers.ts's note
 * on `authorization`), and treating every bearer as ours would resolve that
 * JWT against `cli_tokens`, fail, and — because a presented platform token
 * that fails to resolve must not fall through to a cookie — log that visitor
 * out of their own app. Duplicated here rather than imported from
 * headers.ts, which strips the same shape on the way out to an upstream: the
 * two need to change together, but headers.ts stays free of config.ts's
 * AUTH_SECRET requirement.
 */
const PLATFORM_TOKEN_PREFIX = "ss_";

/** sha256 of the raw token, hex — must agree with apps/web/lib/cli-tokens.ts's hash(). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The bearer token, but only when it is shaped like a platform-minted one. */
export function platformTokenFrom(header: string | undefined): string | null {
  const token = bearerFrom(header);
  return token && token.startsWith(PLATFORM_TOKEN_PREFIX) ? token : null;
}

/**
 * The owner, however they arrived.
 *
 * A person carries the .supersonic.cv session cookie; their agent carries a CLI
 * token. Both resolve to one user id and one Visitor, so nothing downstream —
 * least of all the Accept branch — ever learns which was used. Mastodon's
 * controller has this same fork and needs a different auth path per
 * representation; keeping it inside one function is what stops that spreading.
 */
async function queryPlatformToken(token: string): Promise<Visitor | null> {
  const hash = hashToken(token);
  try {
    const r = await db().query(
      `UPDATE cli_tokens SET last_used_at = now() WHERE token_hash = $1
         RETURNING user_id`, [hash],
    );
    if (!r.rows.length) return null;
    const u = await db().query(`SELECT id, email, name FROM users WHERE id = $1`, [r.rows[0].user_id]);
    if (!u.rows.length) return null;
    return oneVisitor(u.rows[0].id, u.rows[0].email, u.rows[0].name);
  } catch {
    return null;
  }
}

/**
 * How readVisitor resolves a platform token to its owner.
 *
 * A variable so a test can replace it without a live database — the same seam
 * idtoken.ts uses for the metadata server, and for the same reason: a test
 * that needs to avoid a live dependency should replace the thing that reaches
 * it, not add a branch to the thing being tested. This proxy's dev environment
 * commonly has a real cloud-sql-proxy tunnel to the shared Postgres already
 * running on 127.0.0.1:5433 (see db.ts) — without this seam, a test exercising
 * "the token does not resolve" would silently exercise a live production
 * connection instead of the behaviour it means to test.
 *
 * Nothing in production assigns to this.
 */
export let resolvePlatformToken: (token: string) => Promise<Visitor | null> = queryPlatformToken;

/**
 * Replace the platform-token resolver for a test. Returns the function that
 * puts it back — returning the restore rather than exporting a reset means a
 * test cannot forget which state it was in, and two tests cannot disagree
 * about it.
 */
export function setPlatformTokenResolver(fn: (token: string) => Promise<Visitor | null>): () => void {
  const previous = resolvePlatformToken;
  resolvePlatformToken = fn;
  return () => {
    resolvePlatformToken = previous;
  };
}

/**
 * decodeURIComponent throws on a malformed percent sequence. A stray "%" in any
 * unrelated cookie would otherwise take down the whole request with a 500,
 * instead of the visitor simply being treated as signed out.
 */
function decodeValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeValue(part.slice(i + 1).trim());
  }
  return out;
}

export async function readVisitor(req: IncomingMessage): Promise<Visitor | null> {
  const token = platformTokenFrom(req.headers.authorization as string | undefined);
  if (token) return resolvePlatformToken(token);
  const raw = parseCookies(req.headers.cookie)[config.sessionCookieName];
  if (!raw) return null;
  try {
    // In Auth.js v5 the salt is the cookie name.
    const token = await decode({
      token: raw,
      secret: config.authSecret,
      salt: config.sessionCookieName,
    });
    if (!token?.sub || !token.email) return null;
    return oneVisitor(token.sub, token.email, token.name);
  } catch {
    return null;
  }
}

/**
 * The viewer of ONE request, resolved at most once however many branches ask.
 *
 * Not a cache: the closure is made per request and dies with it, so nothing is
 * remembered about anybody between requests and no invalidation question exists.
 * It is here rather than inline at the call site because the cost being avoided
 * belongs to this module — with a bearer token each resolution is an UPDATE
 * plus a SELECT, so a request that asked twice paid four queries and two writes
 * to learn one thing, and the edge had a path that asked twice.
 *
 * The promise is held, not its result, so two callers in flight together still
 * share one resolution.
 */
export function viewerOnce(req: IncomingMessage): () => Promise<Visitor | null> {
  let pending: Promise<Visitor | null> | null = null;
  return () => (pending ??= readVisitor(req));
}

/** Where to send an anonymous visitor, preserving the page they wanted. */
export function signInRedirect(req: IncomingMessage): string {
  const host = (req.headers.host ?? "").split(":")[0];
  const back = `https://${host}${req.url ?? "/"}`;
  return `${config.loginUrl}?callbackUrl=${encodeURIComponent(back)}`;
}

/** Login + signup URLs for the gate page, both carrying the return-here callback. */
export function authUrls(req: IncomingMessage): { loginUrl: string; signupUrl: string } {
  const host = (req.headers.host ?? "").split(":")[0];
  const cb = encodeURIComponent(`https://${host}${req.url ?? "/"}`);
  const signupBase = config.loginUrl.replace(/\/login$/, "/signup");
  return {
    loginUrl: `${config.loginUrl}?callbackUrl=${cb}`,
    signupUrl: `${signupBase}?callbackUrl=${cb}`,
  };
}
