import { getPool } from "./db";

const DB = "supersonic_platform";

export interface User {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  provider: string;
}

// Accounts are keyed by (email, provider), so a plain email can now match more
// than one row. Auth paths must always disambiguate by provider — use
// findUserByEmailAndProvider. This helper stays only for callers that genuinely
// want "any account with this email" and returns the first match.
export async function findUserByEmail(email: string): Promise<User | null> {
  const r = await getPool(DB).query("SELECT * FROM users WHERE email=$1 LIMIT 1", [email.toLowerCase()]);
  return r.rows[0] ?? null;
}

export async function findUserByEmailAndProvider(email: string, provider: string): Promise<User | null> {
  const r = await getPool(DB).query(
    "SELECT * FROM users WHERE email=$1 AND provider=$2",
    [email.toLowerCase(), provider]
  );
  return r.rows[0] ?? null;
}

export interface Account {
  id: string;
  email: string;
  name: string | null;
  provider: string;
  hasPassword: boolean;
}

export async function getAccount(id: string): Promise<Account | null> {
  const r = await getPool(DB).query(
    "SELECT id, email, name, provider, (password_hash IS NOT NULL) AS has_password FROM users WHERE id=$1",
    [id]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, provider: row.provider, hasPassword: row.has_password };
}

export async function updateName(id: string, name: string): Promise<void> {
  await getPool(DB).query("UPDATE users SET name=$2 WHERE id=$1", [id, name.trim() || null]);
}

export async function createUser(email: string, name: string, passwordHash: string | null, provider = "credentials"): Promise<User> {
  const r = await getPool(DB).query(
    `INSERT INTO users(email, name, password_hash, provider) VALUES($1,$2,$3,$4)
     ON CONFLICT(email, provider) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
     RETURNING *`,
    [email.toLowerCase(), name || null, passwordHash, provider]
  );
  return r.rows[0];
}

/**
 * Record that the identity provider proved this address belongs to this person.
 *
 * Raised only — see the note at the call site in auth.ts. A password account
 * never reaches here, which is the point: `users.email_verified` is what a
 * domain rule on an app is allowed to trust.
 */
export async function markEmailVerified(email: string, provider: string): Promise<void> {
  await getPool(DB).query(
    `UPDATE users SET email_verified = true
     WHERE email = $1 AND provider = $2 AND email_verified = false`,
    [email.toLowerCase(), provider]
  );
}
