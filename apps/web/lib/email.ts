// Transactional email via AgentMail (https://agentmail.to).
// Keys are read from the environment; until they're set, sends are logged and
// skipped so the surrounding flow still works.

import { appUrl, productName } from "./brand";

const API = "https://api.agentmail.to/v0";

export interface SendResult { ok: boolean; skipped?: boolean; error?: string }

/** "You now have access" — sent when the owner grants someone (invite or approval). */
export async function sendAccessGranted(to: string, slug: string): Promise<SendResult> {
  return sendEmail({
    to,
    subject: `You now have access to ${slug}`,
    text: `You've been given access to the app "${slug}" on ${productName()}.\n\nOpen it: ${appUrl(slug)}`,
  });
}

export async function sendEmail(msg: {
  to: string; subject: string; text: string; html?: string;
}): Promise<SendResult> {
  const key = process.env.AGENTMAIL_API_KEY;
  const inbox = process.env.AGENTMAIL_INBOX; // e.g. notifications@supersonic.agentmail.to
  if (!key || !inbox) {
    console.log(`[email skipped — no AGENTMAIL creds] to=${msg.to} subject=${msg.subject}`);
    return { ok: true, skipped: true };
  }
  try {
    const r = await fetch(`${API}/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `agentmail ${r.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
