/**
 * Single-use tokens for password reset and address confirmation.
 *
 * WHY THE TOKEN IS STORED HASHED
 *
 * A reset token is a bearer credential for somebody's account — anybody holding
 * it can set the password. Stored in plaintext, the table is a list of working
 * account takeovers, and it leaks everywhere a table leaks: a backup, a query in
 * a log, a screenshot of a DB viewer. (We ship a DB viewer.) So only the SHA-256
 * goes in, the plaintext exists in the email and nowhere else, and lookup is BY
 * hash — which is also why no constant-time compare is needed here: we never
 * compare, we index.
 *
 * Same treatment for verification tokens. They are worth less, but "worth less"
 * is not a reason to hold a credential in the clear.
 */
import { randomBytes, createHash } from "node:crypto";
import { getPool } from "./db";

const DB = "supersonic_platform";

/** An hour. Long enough to find the email, short enough that a stale one is dead. */
export const RESET_TTL_MIN = 60;
/** A week. Confirmation is not urgent and nothing is gated on it. */
const VERIFY_TTL_DAYS = 7;

/** 32 bytes, url-safe: it travels in a query string. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ----------------------------------------------------------- password reset */

/** Create a reset token for a user. Returns the PLAINTEXT, which only the email sees. */
export async function createPasswordReset(userId: string): Promise<string> {
  const token = mintToken();
  await getPool(DB).query(
    `INSERT INTO password_resets (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [hash(token), userId, String(RESET_TTL_MIN)],
  );
  return token;
}

/** What a token is worth, without spending it — for rendering the form. */
export async function peekPasswordReset(token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  const r = await getPool(DB).query(
    `SELECT user_id FROM password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hash(token)],
  );
  return r.rows[0] ? { userId: r.rows[0].user_id } : null;
}

/**
 * Spend a token, atomically.
 *
 * The UPDATE ... WHERE used_at IS NULL RETURNING is the whole guarantee: two
 * requests carrying the same link race in Postgres and exactly one gets a row.
 * Checking then updating would let both through, which is a forwarded email
 * being redeemed twice.
 *
 * Every OTHER outstanding reset for the user is spent at the same time. Somebody
 * who clicked "forgot password" four times has four live links in their mailbox,
 * and the three they did not use should not stay usable — nor should a link an
 * attacker requested before the real owner recovered the account.
 */
export async function redeemPasswordReset(token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  const pool = getPool(DB);
  const r = await pool.query(
    `UPDATE password_resets SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hash(token)],
  );
  const userId = r.rows[0]?.user_id;
  if (!userId) return null;
  await pool.query(
    `UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return { userId };
}

/* ------------------------------------------------------ email verification */

export async function createEmailVerification(userId: string, email: string): Promise<string> {
  const token = mintToken();
  await getPool(DB).query(
    `INSERT INTO email_verifications (token_hash, user_id, email, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [hash(token), userId, email.toLowerCase(), String(VERIFY_TTL_DAYS)],
  );
  return token;
}

/**
 * Confirm an address.
 *
 * The token carries the address it proves, and the write requires the user still
 * to have that address — so a token minted before an email change cannot verify
 * the new one.
 */
export async function redeemEmailVerification(token: string): Promise<{ userId: string; email: string } | null> {
  if (!token) return null;
  const pool = getPool(DB);
  const r = await pool.query(
    `UPDATE email_verifications SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, email`,
    [hash(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  // BOTH columns. `email_verified` is the one anything reads — 034_domain_grants
  // gates domain rules on it — and leaving it false would make this feature a
  // second, weaker record of the same fact. `email_verified_at` is only the when.
  // See the migration for why raising it from here is the flag's intended
  // meaning rather than a widening of it.
  await pool.query(
    `UPDATE users SET email_verified = true, email_verified_at = now()
      WHERE id = $1 AND lower(email) = $2`,
    [row.user_id, String(row.email).toLowerCase()],
  );
  return { userId: row.user_id, email: row.email };
}

/** Whether an address is confirmed. Nothing is gated on this — see the migration. */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const r = await getPool(DB).query(`SELECT email_verified FROM users WHERE id = $1`, [userId]);
  return Boolean(r.rows[0]?.email_verified);
}
