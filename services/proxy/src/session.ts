import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { decode } from "@auth/core/jwt";
import { config } from "./config";
import { db } from "./db";

export interface Visitor { userId: string; email: string; name: string }

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
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
async function visitorFromBearer(token: string): Promise<Visitor | null> {
  const hash = createHash("sha256").update(token).digest("hex");
  try {
    const r = await db().query(
      `UPDATE cli_tokens SET last_used_at = now() WHERE token_hash = $1
         RETURNING user_id`, [hash],
    );
    if (!r.rows.length) return null;
    const u = await db().query(`SELECT id, email, name FROM users WHERE id = $1`, [r.rows[0].user_id]);
    if (!u.rows.length) return null;
    return { userId: u.rows[0].id, email: u.rows[0].email, name: u.rows[0].name ?? "" };
  } catch {
    return null;
  }
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
  const token = bearerFrom(req.headers.authorization as string | undefined);
  if (token) return visitorFromBearer(token);
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
    return { userId: token.sub, email: String(token.email).toLowerCase(), name: String(token.name ?? "") };
  } catch {
    return null;
  }
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
