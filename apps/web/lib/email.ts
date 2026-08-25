/**
 * Transactional email, via AgentMail (https://agentmail.to).
 *
 * WHY A SEND IS CLAIMED BEFORE IT IS SENT
 *
 * `invoice.payment_failed` fires once per dunning ATTEMPT — Stripe retries a
 * failing card about four times over two weeks — and Stripe also re-delivers any
 * webhook it did not receive a 2xx for. Two instances of the control plane can
 * be handed the same delivery at the same time, which on Cloud Run is normal
 * rather than exotic. Send-then-record loses that race in the direction that
 * shows: the customer gets eight copies of "your payment failed".
 *
 * So a send is CLAIMED first. `sent_emails.dedupe_key` is UNIQUE, and the insert
 * is the lock — `ON CONFLICT DO NOTHING RETURNING id` either hands us the row or
 * tells us somebody else already owns this exact message. Postgres arbitrates,
 * so there is no window and no coordination.
 *
 * WHY THERE IS NO `from`
 *
 * AgentMail's send API has no from field: the sender IS the inbox posted to, so
 * the address lives entirely in `AGENTMAIL_INBOX` and changing it is an env
 * change rather than a deploy. Sending as `hello@thebay.cloud` requires that
 * domain verified in AgentMail (SPF/DKIM/DMARC); until it is, this sends from
 * whatever inbox exists and `reply_to` still lands replies with a human.
 */
import { getPool } from "./db";
import { CONTACT_EMAIL } from "./brand";
import { renderEmail, type EmailContent } from "./email-template";

const API = "https://api.agentmail.to/v0";
const DB = "supersonic_platform";

/** How many times a failed send is retried by the sweep before it is left alone. */
const MAX_ATTEMPTS = 4;

/** Long enough for a slow provider, short enough not to hold a signup open. */
const SEND_TIMEOUT_MS = 8000;

export interface SendResult {
  ok: boolean;
  /** No credentials, a duplicate claim, or a suppressed address — all "nothing sent, nothing wrong". */
  skipped?: boolean;
  /** Why it was skipped, for the caller's log line. */
  reason?: "no-credentials" | "duplicate" | "suppressed";
  error?: string;
}

export interface Outgoing {
  /** Which email this is: "welcome", "password_reset", "payment_failed", … */
  kind: string;
  /**
   * What makes this send unique, composed by the caller so the rule lives with
   * the reason for it — `payment_failed:<invoice>:<attempt>` rather than
   * anything this module could guess.
   */
  dedupeKey: string;
  to: string;
  userId?: string | null;
  subject: string;
  content: EmailContent;
}

/** Whether email is configured at all. Everything stays inert and logs when not. */
export function emailConfigured(): boolean {
  return Boolean(process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX);
}

async function isSuppressed(email: string): Promise<boolean> {
  try {
    const r = await getPool(DB).query("SELECT 1 FROM email_suppressions WHERE email = $1", [email.toLowerCase()]);
    return r.rowCount ? true : false;
  } catch {
    // A failed read is not a suppression. Refusing to send a password reset
    // because a lookup table was briefly unreachable is the worse error.
    return false;
  }
}

/** Record an address we must stop mailing. Called on a hard bounce or a complaint. */
export async function suppress(email: string, reason: "bounce" | "complaint" | "manual", detail?: string): Promise<void> {
  await getPool(DB).query(
    `INSERT INTO email_suppressions (email, reason, detail) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail`,
    [email.toLowerCase(), reason, detail ?? null],
  );
}

/**
 * The provider call. Separated so the retry sweep can reuse it without
 * re-claiming a row it already owns.
 */
async function post(msg: { to: string; subject: string; text: string; html: string }): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.AGENTMAIL_API_KEY;
  const inbox = process.env.AGENTMAIL_INBOX;
  if (!key || !inbox) return { ok: false, error: "no credentials" };
  try {
    const r = await fetch(`${API}/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
      method: "POST",
      // Bounded, because callers AWAIT this. `fetch` has no default timeout, so
      // an unresponsive provider would hang whatever triggered the mail — and
      // one of those callers is signup. A timeout lands in the ledger as a
      // failure, which is retryable; a hang is neither.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        // Replies reach a person rather than an inbox nobody opens. This is the
        // whole reason the sending address can be a machine one.
        reply_to: CONTACT_EMAIL,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `agentmail ${r.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Send one email, at most once.
 *
 * Never throws: every caller is a side effect of something more important than
 * the email — a signup, a webhook, a deploy — and none of them should fail
 * because a mail API did.
 */
export async function send(out: Outgoing): Promise<SendResult> {
  const to = out.to?.trim();
  if (!to) return { ok: true, skipped: true, reason: "no-credentials" };

  const { html, text } = renderEmail(out.content);
  const pool = getPool(DB);

  // Claim. A conflict means this exact message is already somebody's job.
  let claimId: number | null = null;
  try {
    const r = await pool.query(
      `INSERT INTO sent_emails (dedupe_key, kind, recipient, user_id, subject, status)
       VALUES ($1,$2,$3,$4,$5,'claimed')
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [out.dedupeKey, out.kind, to, out.userId ?? null, out.subject],
    );
    if (!r.rows[0]) return { ok: true, skipped: true, reason: "duplicate" };
    claimId = Number(r.rows[0].id);
  } catch (e) {
    // The log is not the ledger. If we cannot claim, we do not send — otherwise
    // the one guarantee this module offers (at most once) is the first thing to
    // go when the database is unhappy.
    console.error(`[email ${out.kind}] could not claim: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: "could not claim send" };
  }

  const settle = async (status: string, error?: string) => {
    try {
      await pool.query(
        `UPDATE sent_emails SET status=$2, attempts=attempts+1, last_error=$3, updated_at=now() WHERE id=$1`,
        [claimId, status, error ?? null],
      );
    } catch { /* the send is what matters; the bookkeeping can lose */ }
  };

  if (await isSuppressed(to)) {
    await settle("skipped", "address suppressed");
    return { ok: true, skipped: true, reason: "suppressed" };
  }
  if (!emailConfigured()) {
    console.log(`[email skipped — no AGENTMAIL creds] kind=${out.kind} to=${to} subject=${out.subject}`);
    await settle("skipped", "no credentials");
    return { ok: true, skipped: true, reason: "no-credentials" };
  }

  const r = await post({ to, subject: out.subject, text, html });
  await settle(r.ok ? "sent" : "failed", r.error);
  if (!r.ok) console.error(`[email ${out.kind}] send failed to ${to}: ${r.error}`);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Re-send what the provider refused.
 *
 * A dropped deploy notice is a shrug; a dropped password reset is a locked-out
 * account with no second attempt, because the token is already spent from the
 * user's point of view — they clicked "reset" and nothing came. So failures are
 * kept and retried rather than logged and forgotten.
 *
 * Re-renders from the stored subject and kind is NOT possible — the body is not
 * stored, on purpose: reset tokens and error text would then live in a table
 * forever. So the sweep can only retry sends whose body it can rebuild, which
 * today means it retries nothing and exists to be called with a rebuilt body by
 * the caller that owns it. `retryable()` is what a caller asks first.
 */
export async function retryable(dedupeKey: string): Promise<boolean> {
  try {
    const r = await getPool(DB).query(
      `SELECT status, attempts FROM sent_emails WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    const row = r.rows[0];
    if (!row) return true; // never attempted
    return row.status === "failed" && Number(row.attempts) < MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

/**
 * Send, or re-send if the last attempt failed.
 *
 * The dedupe key still guarantees at-most-one SUCCESSFUL send: this only clears
 * the claim when the previous attempt is a recorded failure with attempts left,
 * so a duplicate delivery can only happen if the provider accepted a message and
 * told us it had not.
 */
export async function sendOrRetry(out: Outgoing): Promise<SendResult> {
  const first = await send(out);
  if (!first.skipped || first.reason !== "duplicate") return first;
  if (!(await retryable(out.dedupeKey))) return first;
  try {
    await getPool(DB).query(`DELETE FROM sent_emails WHERE dedupe_key = $1 AND status = 'failed'`, [out.dedupeKey]);
  } catch {
    return first;
  }
  return send(out);
}

/**
 * The low-level escape hatch: a plaintext send with no dedupe and no template.
 *
 * Kept for the three senders that predate this module's ledger. New callers use
 * `send()` — a message worth sending is worth sending exactly once.
 */
export async function sendEmail(msg: { to: string; subject: string; text: string; html?: string }): Promise<SendResult> {
  if (!emailConfigured()) {
    console.log(`[email skipped — no AGENTMAIL creds] to=${msg.to} subject=${msg.subject}`);
    return { ok: true, skipped: true, reason: "no-credentials" };
  }
  const r = await post({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html ?? "" });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
