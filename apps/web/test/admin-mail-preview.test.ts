import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The gate on the preview sender, and what it refuses to send.
 *
 * Its own file because `mock.module` is process-wide and may only be installed
 * once per module graph — the same reason `admin-fleet-route.test.ts` is separate.
 *
 * What matters here is not the copy. It is that a route which SENDS MAIL to an
 * address in the query string cannot be reached by anybody who is not an
 * operator, and that a refusal costs no send at all — the mail equivalent of the
 * fleet route asserting its reader was never called.
 */

let admin: string | null = null;
let sends: { to: string; subject: string; text: string; html: string }[] = [];

mock.module("@/lib/admin", {
  namedExports: { currentAdminEmail: async () => admin },
});

mock.module("@/lib/email", {
  namedExports: {
    emailConfigured: () => true,
    sendEmail: async (m: { to: string; subject: string; text: string; html?: string }) => {
      // The BODIES are captured too, because the last test in this file is about
      // what is inside one and a stand-in that dropped them would let it pass
      // while asserting nothing.
      sends.push({ to: m.to, subject: m.subject, text: m.text, html: m.html ?? "" });
      return { ok: true };
    },
  },
});

const loaded = import("@/app/api/admin/mail-preview/route");

async function post(as: string | null, url: string, body?: unknown) {
  admin = as;
  sends = [];
  const { POST } = await loaded;
  return POST(
    new Request(url, {
      method: "POST",
      ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    }),
  );
}

const URL_BASE = "https://app.thebay.cloud/api/admin/mail-preview";

test("a caller who is not an operator gets 404 and no mail is sent", async () => {
  const res = await post(null, `${URL_BASE}?to=someone@example.com`);
  assert.equal(res.status, 404, "a stranger should not learn this route exists");
  assert.deepEqual(sends, [], "a refused request must not send anything");
});

test("an operator sends the whole set to the address they gave", async () => {
  const res = await post("ops@thebay.cloud", `${URL_BASE}?to=arsen@example.com`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { to: string; sent: number; failed: number };
  assert.equal(body.to, "arsen@example.com");
  assert.equal(body.failed, 0);
  // Every sample, including the three deploy outcomes that come off the real
  // builder rather than being retyped.
  assert.ok(body.sent >= 12, `expected the full set, sent ${body.sent}`);
  assert.ok(sends.every((s) => s.to === "arsen@example.com"), "a send went somewhere else");
});

test("every preview says so in its subject", async () => {
  // Twelve unmarked emails arriving at once are indistinguishable from a loop
  // that mailed a real user, which is the thing somebody would panic about.
  await post("ops@thebay.cloud", `${URL_BASE}?to=arsen@example.com`);
  for (const s of sends) assert.match(s.subject, /^\[preview\] /, `unmarked: ${s.subject}`);
});

test("a malformed address is refused before anything is sent", async () => {
  const res = await post("ops@thebay.cloud", `${URL_BASE}?to=not-an-address`);
  assert.equal(res.status, 400);
  assert.deepEqual(sends, [], "a typo must not become twelve bounces");
});

test("the address defaults to the operator's own", async () => {
  // So the lazy call — no query string — cannot mail a stranger.
  const res = await post("ops@thebay.cloud", URL_BASE);
  assert.equal(res.status, 200);
  assert.ok(sends.length > 0);
  assert.ok(sends.every((s) => s.to === "ops@thebay.cloud"));
});

test("`only` narrows the set", async () => {
  const res = await post("ops@thebay.cloud", `${URL_BASE}?only=password`);
  assert.equal(res.status, 200);
  assert.equal(sends.length, 1);
  assert.match(sends[0].subject, /Reset your/);
});

test("a password-reset preview never carries a working token", async () => {
  // A preview lands in a mailbox and gets forwarded and searched. A real reset
  // token in one is a live credential for an account sitting in mail nobody
  // treats as sensitive — so the link must be inert, and this checks the LINK
  // rather than counting sends.
  await post("ops@thebay.cloud", `${URL_BASE}?to=arsen@example.com&only=password`);
  assert.equal(sends.length, 1);
  const both = `${sends[0].text}\n${sends[0].html}`;
  assert.match(both, /token=preview-not-a-real-token/, "the preview link should be an obvious placeholder");
  // A real token is 32 random bytes as base64url — 43 characters. Nothing that
  // shape belongs in a preview.
  assert.doesNotMatch(both, /token=[A-Za-z0-9_-]{40,}/, "that looks like a real reset token");
});
