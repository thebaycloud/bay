export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Send every email to one address, to look at them in a real client.
 *
 * The proof sheet renders them in a browser, which answers "is the copy right"
 * and not "does Gmail keep the table layout, does Outlook lose the button, does
 * the logo load at all". Only a real send answers those, and the credentials for
 * it live on this service rather than on anybody's laptop — so the tool belongs
 * here.
 *
 * WHY IT BYPASSES THE LEDGER
 *
 * `send()` claims a row in `sent_emails` before it sends, so a test would either
 * be refused as a duplicate the second time it ran, or would burn the real dedupe
 * key for a real user's welcome. `sendEmail()` is the escape hatch that skips the
 * claim, which is exactly right for a preview and exactly wrong for anything a
 * user is owed.
 *
 * WHY THE ADDRESS IS A PARAMETER
 *
 * Previews are looked at in whichever inbox somebody actually reads, which is
 * usually not the address their account is under. The gate is the operator
 * allowlist — the same `currentAdminEmail` the fleet route and the analytics page
 * use, not a second mechanism — and an operator can already read every tenant's
 * logs, so "an operator may send twelve emails to an address they typed" is not
 * the loosest thing they can do. A caller who is not an operator gets 404 rather
 * than 403, for the reason the fleet route gives: there is no reason to confirm
 * to a stranger that this exists.
 */
import { currentAdminEmail } from "@/lib/admin";
import { sendEmail, emailConfigured } from "@/lib/email";
import { renderEmail, type EmailContent } from "@/lib/email-template";
import { productName } from "@/lib/brand";
import { deployEmail } from "@/lib/deploy-notify";

/** A plausible address, so a typo does not become twelve bounces. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The same content the real senders build.
 *
 * Copied rather than called, because every real sender writes to the ledger and
 * takes a real user id. The bodies are what matter for a rendering check, and the
 * ones that quote something — an error, a fix prompt — carry realistic text so
 * the code blocks are exercised rather than shown empty.
 */
function samples(): { kind: string; subject: string; content: EmailContent }[] {
  const P = productName();
  const out: { kind: string; subject: string; content: EmailContent }[] = [
    {
      kind: "welcome",
      subject: `Welcome to ${P}`,
      content: {
        preheader: "Two commands and your app is on the internet.",
        heading: "Welcome, Arsen",
        blocks: [
          { p: `Your account is ready. ${P} deploys whatever is in a folder — no config file, no Dockerfile, no YAML.` },
          { label: "From your project directory:", code: "npm i -g @thebaycloud/cli\nbay deploy" },
          { p: "That reads your project, builds it, and gives you a URL. If the build fails, you get a fix prompt you can paste straight into your coding agent." },
        ],
        cta: { label: "Open the dashboard", url: "https://app.thebay.cloud" },
        footnote: "Three apps are free, and stay free.",
      },
    },
    {
      kind: "password_reset",
      subject: `Reset your ${P} password`,
      content: {
        preheader: "This link works for 60 minutes.",
        heading: "Reset your password",
        blocks: [{ p: "Click below to choose a new password. The link works once." }],
        // A dead token on purpose: a preview must not carry a working credential
        // into a mailbox, and the link's job here is to be looked at.
        cta: { label: "Choose a new password", url: "https://app.thebay.cloud/reset?token=preview-not-a-real-token" },
        footnote: "The link expires in 60 minutes. If you didn't ask for this, you can ignore this email — your password hasn't changed.",
      },
    },
    {
      kind: "verify_email",
      subject: "Confirm your email address",
      content: {
        preheader: "One click, so we know we can reach you.",
        heading: "Confirm your email",
        blocks: [
          { p: "Confirming lets us reach you about deploys, failed payments and anything going wrong with an app — the mail you'd actually want." },
          { p: "Nothing is blocked until you do. You can keep deploying." },
        ],
        cta: { label: "Confirm this address", url: "https://app.thebay.cloud/verify?token=preview-not-a-real-token" },
      },
    },
    {
      kind: "payment_failed",
      subject: "Your payment didn't go through",
      content: {
        preheader: "We'll try again on September 2.",
        heading: "Your card was declined",
        blocks: [
          { p: `We couldn't charge $20.00 for your ${P} subscription.` },
          { p: "We'll try again on September 2. Updating your card now is the quickest way to sort it — nothing changes about your apps in the meantime." },
        ],
        cta: { label: "Update payment method", url: "https://app.thebay.cloud/settings" },
        footnote: "Usually this is an expired card or a bank hold, not anything you did wrong.",
      },
    },
    {
      kind: "subscription_lapsed",
      subject: `Your ${P} subscription has ended`,
      content: {
        preheader: "Your apps are still running. Here's what changed.",
        heading: "You're back on the free plan",
        blocks: [
          { p: "Nothing has been deleted and nothing has stopped serving. What changes is the ceilings:" },
          {
            facts: [
              { key: "Apps", value: "3 (existing apps keep running)" },
              { key: "Public apps", value: "1" },
              { key: "Builds", value: "30 a month" },
              { key: "Auto-fix", value: "not included — you still get a paste-ready fix prompt" },
              { key: "Badge", value: `apps show a "Runs on ${P}" badge again` },
            ],
          },
          { p: "Resubscribing puts everything back exactly as it was." },
        ],
        cta: { label: "Resubscribe", url: "https://app.thebay.cloud/settings" },
      },
    },
    {
      kind: "approaching_limit",
      subject: "You've used 24 of 30 builds this month",
      content: {
        preheader: "They reset on September 1.",
        heading: "You're close to this month's build limit",
        blocks: [
          { p: "You've used 24 of your 30 builds. They reset on September 1." },
          { p: "Telling you now rather than refusing a deploy later, which is how you'd otherwise find out." },
        ],
        cta: { label: "See plans", url: "https://app.thebay.cloud/settings" },
      },
    },
    {
      kind: "production_errors",
      subject: "l3sgp is throwing errors",
      content: {
        preheader: "41 errors in the last hour.",
        heading: "l3sgp is erroring in production",
        blocks: [
          { p: "41 errors were logged in the last hour. The most recent one:" },
          {
            label: "Most recent error",
            code:
              "TypeError: Cannot read properties of undefined (reading 'id')\n" +
              "    at getUser (/srv/apps/l3sgp/server.js:118:22)\n" +
              "    at /srv/apps/l3sgp/routes/api.js:44:9",
          },
          { p: "Open the app's Logs tab for the full picture — there's a button there that writes a fix prompt you can paste into your coding agent." },
        ],
        cta: { label: "View l3sgp logs", url: "https://app.thebay.cloud/apps/l3sgp?tab=logs" },
      },
    },
    {
      kind: "access_granted",
      subject: "You now have access to l3sgp",
      content: {
        preheader: "l3sgp is open to you.",
        heading: "You have access to l3sgp",
        blocks: [{ p: `You've been given access to the app "l3sgp" on ${P}.` }],
        cta: { label: "Open l3sgp", url: "https://l3sgp.thebay.cloud" },
      },
    },
    {
      kind: "access_requested",
      subject: "sam@acme.com is requesting access to l3sgp",
      content: {
        preheader: "Grant or deny it from l3sgp's Share settings.",
        heading: "sam@acme.com wants access to l3sgp",
        blocks: [{ p: 'sam@acme.com asked for access to your app "l3sgp". You can grant or deny it from the app\'s Share settings.' }],
        cta: { label: "Review the request", url: "https://app.thebay.cloud/apps/l3sgp" },
      },
    },
  ];

  // The three deploy outcomes come from the REAL builder rather than being
  // retyped — it is the one message with branching logic (failed, partial,
  // clean) and a redaction pass, so a preview that bypassed it would be
  // previewing something we do not send.
  for (const d of [
    { slug: "abc12", name: "tasks", status: "failed", error: 'npm start → Missing script "start"' },
    { slug: "abc12", name: "tasks", status: "live", stage: "1 service(s) not served — /api: Deploying backend failed: probe timed out" },
    { slug: "abc12", name: "tasks", status: "live" },
  ]) {
    const m = deployEmail(d);
    if (m) out.push({ kind: `deploy:${d.status}${d.stage ? ":partial" : ""}`, subject: m.subject, content: m.content });
  }
  return out;
}

export async function POST(req: Request) {
  const admin = await currentAdminEmail();
  if (!admin) return new Response("not found", { status: 404 });
  if (!emailConfigured()) {
    return Response.json({ error: "AGENTMAIL_API_KEY / AGENTMAIL_INBOX are not both set on this service" }, { status: 503 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const to = String(body?.to ?? url.searchParams.get("to") ?? admin).trim();
  if (!EMAIL.test(to)) return Response.json({ error: `not an address: ${to}` }, { status: 400 });

  const only = String(body?.only ?? url.searchParams.get("only") ?? "").trim();
  const all = samples();
  const chosen = only ? all.filter((s) => s.kind.includes(only)) : all;
  if (!chosen.length) return Response.json({ error: `no email matches "${only}"`, kinds: all.map((s) => s.kind) }, { status: 400 });

  const results: { kind: string; ok: boolean; error?: string }[] = [];
  for (const s of chosen) {
    const { html, text } = renderEmail(s.content);
    // Marked in the SUBJECT, not only the body: twelve unmarked emails landing at
    // once look exactly like a broken loop that mailed a real user.
    const r = await sendEmail({ to, subject: `[preview] ${s.subject}`, text, html });
    results.push({ kind: s.kind, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  }

  return Response.json({
    to,
    sentBy: admin,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
