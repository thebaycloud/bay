import { getPool } from "./db";

const DB = "supersonic_platform";

// Access requests from people who hit a private app and asked the owner for in.

/** Record (or re-open) a pending request for an app. Email is stored lowercased. */
export async function addRequest(appId: string, email: string): Promise<void> {
  await getPool(DB).query(
    `INSERT INTO access_requests(app_id, email, status) VALUES($1, lower($2), 'pending')
     ON CONFLICT (app_id, email) DO UPDATE SET status = 'pending', created_at = now()`,
    [appId, email],
  );
}

/** Emails with a still-pending request for this app. */
export async function listPending(slug: string): Promise<string[]> {
  const r = await getPool(DB).query(
    `SELECT ar.email FROM access_requests ar
       JOIN apps a ON a.id = ar.app_id
     WHERE a.slug = $1 AND ar.status = 'pending'
     ORDER BY ar.created_at`,
    [slug],
  );
  return r.rows.map((x) => x.email as string);
}

export async function resolveRequest(slug: string, email: string, status: "approved" | "denied"): Promise<void> {
  await getPool(DB).query(
    `UPDATE access_requests SET status = $3
       FROM apps a
     WHERE access_requests.app_id = a.id AND a.slug = $1 AND lower(access_requests.email) = lower($2)`,
    [slug, email, status],
  );
}
