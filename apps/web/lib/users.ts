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

export async function createUser(email: string, name: string, passwordHash: string | null, provider = "credentials"): Promise<User> {
  const r = await getPool(DB).query(
    `INSERT INTO users(email, name, password_hash, provider) VALUES($1,$2,$3,$4)
     ON CONFLICT(email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
     RETURNING *`,
    [email.toLowerCase(), name || null, passwordHash, provider]
  );
  return r.rows[0];
}
