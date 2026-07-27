import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getPool } from "./db";
import { HttpError, type Account } from "./http";

/**
 * Tokens are random 32-byte secrets, stored only as a SHA-256 hash. There is no
 * password to guess and the token is high-entropy, so a plain hash is enough —
 * we are not defending against an offline dictionary attack.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return `sok_${randomBytes(32).toString("base64url")}`;
}

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

const ACCOUNT_COLUMNS = `id, label, email, timezone, daily_invite_cap,
  daily_message_cap, active_hour_start, active_hour_end`;

/** Resolve the request's bearer token to an active account, or throw 401. */
export async function authenticate(authHeader: string | undefined): Promise<Account> {
  const token = bearerFrom(authHeader);
  if (!token) throw new HttpError(401, "missing bearer token");

  const { rows } = await getPool().query<Account & { token_hash: string }>(
    `SELECT ${ACCOUNT_COLUMNS}, token_hash FROM accounts WHERE token_hash = $1 AND active`,
    [hashToken(token)],
  );
  if (!rows.length) throw new HttpError(401, "unknown or inactive token");

  // The lookup above already matched on the hash, but comparing again in
  // constant time keeps the pattern correct if the lookup ever widens.
  const presented = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(rows[0].token_hash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw new HttpError(401, "unknown or inactive token");
  }

  const { token_hash: _omit, ...account } = rows[0];
  return account;
}
