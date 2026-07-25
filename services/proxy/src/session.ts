import type { IncomingMessage } from "node:http";
import { decode } from "@auth/core/jwt";
import { config } from "./config";

export interface Visitor { userId: string; email: string; name: string }

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readVisitor(req: IncomingMessage): Promise<Visitor | null> {
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
