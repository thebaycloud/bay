import { randomBytes, createHash } from "node:crypto";
import { getPool } from "./db";

const DB = "supersonic_platform";

// The CLI is the interface for the user's coding agent: a human logs in once
// (browser), a token lands in ~/.supersonic, and from then on the agent runs
// commands carrying `Authorization: Bearer <token>`. Tokens are stored hashed;
// the plaintext is shown exactly once at creation.

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = getPool(DB).query(
      `CREATE TABLE IF NOT EXISTS cli_tokens (
         id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id     uuid NOT NULL,
         token_hash  text NOT NULL UNIQUE,
         name        text,
         created_at  timestamptz NOT NULL DEFAULT now(),
         last_used_at timestamptz
       )`
    ).then(() => undefined).catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CliToken { id: string; name: string | null; created_at: string; last_used_at: string | null; }

/** Mint a new token for a user. Returns the plaintext ONCE — it is never recoverable after. */
export async function createToken(userId: string, name: string): Promise<{ token: string; id: string }> {
  await ensure();
  const token = "ss_" + randomBytes(24).toString("base64url");
  const r = await getPool(DB).query(
    "INSERT INTO cli_tokens(user_id, token_hash, name) VALUES($1,$2,$3) RETURNING id",
    [userId, hash(token), name || null]
  );
  return { token, id: r.rows[0].id };
}

/** Resolve a plaintext token to its owner's user id (and stamp last-used). Null if unknown. */
export async function findUserByToken(token: string): Promise<string | null> {
  if (!token || !token.startsWith("ss_")) return null;
  await ensure();
  const r = await getPool(DB).query(
    "UPDATE cli_tokens SET last_used_at = now() WHERE token_hash=$1 RETURNING user_id",
    [hash(token)]
  );
  return r.rows[0]?.user_id ?? null;
}

export async function listTokens(userId: string): Promise<CliToken[]> {
  await ensure();
  const r = await getPool(DB).query(
    "SELECT id, name, created_at, last_used_at FROM cli_tokens WHERE user_id=$1 ORDER BY created_at DESC",
    [userId]
  );
  return r.rows;
}

export async function revokeToken(userId: string, id: string): Promise<boolean> {
  await ensure();
  const r = await getPool(DB).query("DELETE FROM cli_tokens WHERE user_id=$1 AND id=$2", [userId, id]);
  return (r.rowCount ?? 0) > 0;
}
