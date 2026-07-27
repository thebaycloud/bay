import { getPool } from "./db";

const DB = "supersonic_platform";

export interface User {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  provider: string;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const r = await getPool(DB).query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
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
     ON CONFLICT(email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
     RETURNING *`,
    [email.toLowerCase(), name || null, passwordHash, provider]
  );
  return r.rows[0];
}
