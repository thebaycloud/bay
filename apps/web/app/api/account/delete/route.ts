export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { currentUserId } from "@/lib/session";
import { getAccount } from "@/lib/users";
import { getPool } from "@/lib/db";
import { deleteApp } from "@/lib/gcloud";
import { stripe } from "@/lib/stripe";

// Irreversible: tears down every app the user owns, cancels billing, and removes
// the account. Guarded by retyping the account email. Each external teardown is
// best-effort so one failure can't strand the account half-deleted — but the
// final DB delete is the source of truth for "the account is gone".
export async function POST(req: Request) {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const account = await getAccount(uid);
  if (!account) return Response.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  if (String(body.confirm ?? "").trim().toLowerCase() !== account.email.toLowerCase()) {
    return Response.json({ error: "type your email exactly to confirm" }, { status: 400 });
  }

  const pool = getPool("supersonic_platform");

  // 1. Tear down the Cloud Run apps (best-effort — a stuck delete must not block
  //    account removal; the DB delete below is what actually frees the account).
  const owned = await pool.query("SELECT slug FROM apps WHERE owner_id=$1", [uid])
    .catch(() => ({ rows: [] as { slug: string }[] }));
  for (const row of owned.rows as { slug: string }[]) {
    try { await deleteApp(row.slug); } catch { /* already gone / gcloud unavailable */ }
  }

  // 2. Cancel the Stripe subscription if there is one.
  try {
    const r = await pool.query("SELECT stripe_subscription_id FROM users WHERE id=$1", [uid]);
    const subId = r.rows[0]?.stripe_subscription_id;
    const s = stripe();
    if (subId && s) await s.subscriptions.cancel(subId);
  } catch { /* no sub / billing unconfigured */ }

  // 3. Remove the data. app_grants + access_requests cascade when the apps go;
  //    cli_tokens has no FK so it's deleted explicitly. apps.owner_id has no
  //    cascade, so apps must go before the user row.
  try {
    await pool.query("DELETE FROM apps WHERE owner_id=$1", [uid]);
    await pool.query("DELETE FROM cli_tokens WHERE user_id=$1", [uid]);
    await pool.query("DELETE FROM users WHERE id=$1", [uid]);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  return Response.json({ ok: true });
}
