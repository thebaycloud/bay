import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmail } from "../lib/email-template";

/**
 * The one template.
 *
 * What is worth pinning here is not the styling — it is the two properties that
 * are easy to break and invisible when broken: that the plaintext part actually
 * carries the content, and that user-supplied text cannot become markup.
 */

test("both bodies carry the same content", () => {
  const { html, text } = renderEmail({
    preheader: "preview line",
    heading: "Your card was declined",
    blocks: [{ p: "We couldn't charge $20.00." }, { code: "card_declined" }],
    cta: { label: "Update payment method", url: "https://app.thebay.cloud/settings" },
    footnote: "Usually an expired card.",
  });

  for (const [name, body] of [["html", html], ["text", text]] as const) {
    assert.match(body, /Your card was declined/, `${name} is missing the heading`);
    assert.match(body, /couldn't charge \$20\.00/, `${name} is missing the paragraph`);
    assert.match(body, /card_declined/, `${name} is missing the code block`);
    assert.match(body, /Usually an expired card/, `${name} is missing the footnote`);
    // The URL must be in BOTH: a text-only client has no button to press, so the
    // link has to be readable or the email is a dead end.
    assert.match(body, /app\.thebay\.cloud\/settings/, `${name} is missing the CTA url`);
  }
});

test("the plaintext part is not markup", () => {
  // The failure this catches is a "plaintext" body built by stripping tags, or
  // by accidentally passing the HTML through. A text part full of angle brackets
  // is what a text-only client shows, and what a spam filter compares against.
  const { text } = renderEmail({
    preheader: "x",
    heading: "Hello",
    blocks: [{ p: "Plain words." }],
  });
  assert.doesNotMatch(text, /<table|<div|<a |style=/);
});

test("an error quoted from a build cannot become markup", () => {
  // Deploy failures, production errors and fix prompts all quote whatever a tool
  // said, and a tool can say anything. Unescaped, `<script>` in a stack trace is
  // a script in an email — and some clients do run it.
  const nasty = `<script>alert(1)</script> && "quoted" <img src=x onerror=y>`;
  const { html, text } = renderEmail({
    preheader: nasty,
    heading: nasty,
    blocks: [{ p: nasty }, { code: nasty }, { facts: [{ key: nasty, value: nasty }] }],
    cta: { label: nasty, url: "https://app.thebay.cloud" },
    footnote: nasty,
  });

  assert.doesNotMatch(html, /<script>/, "a script tag survived into the HTML body");
  // The dangerous form is a REAL tag carrying a handler. The characters
  // `onerror=` also survive harmlessly as text inside `&lt;img ... &gt;`, which
  // is the correct outcome and must not be mistaken for the unsafe one — the
  // template contains a legitimate <img> for the logo, so this is written to
  // match a handler on a tag rather than the word anywhere.
  assert.doesNotMatch(html, /<img [^>]*onerror/i, "an event handler survived on a real tag");
  assert.match(html, /&lt;script&gt;/, "the text should be escaped, not stripped");
  // The plaintext part is not HTML, so it keeps the characters as typed — that is
  // correct, and worth asserting so nobody "fixes" it by escaping there too.
  assert.match(text, /<script>/);
});

test("a code block keeps its newlines in both bodies", () => {
  const { html, text } = renderEmail({
    preheader: "x",
    heading: "Welcome",
    blocks: [{ code: "npm i -g @thebaycloud/cli\nbay deploy" }],
  });
  // Two commands must not run together into one unusable line.
  assert.match(html, /npm i -g @thebaycloud\/cli\nbay deploy/);
  assert.match(text, /npm i -g @thebaycloud\/cli\n\s+bay deploy/);
});

test("the logo is a PNG with the product name as its alt text", () => {
  // SVG is stripped by Gmail, and remote images are blocked by default on first
  // contact from a new sender — which is the state every one of these emails is
  // sent in. So it must be a raster, and it must degrade to a word.
  const { html } = renderEmail({ preheader: "x", heading: "y", blocks: [] });
  assert.match(html, /<img src="[^"]+\/email\/logo\.png"/);
  assert.match(html, /alt="Bay"/);
  assert.doesNotMatch(html, /logo\.svg|logo-bay\.svg/);
});

test("the light palette is written on the elements, not left to a stylesheet", () => {
  // Gmail strips <head>, and Outlook renders with Word's engine: a <style> block
  // is not a place a colour can live. A body background that is only declared in
  // CSS shows as the client's default, which in a dark-mode client is black text
  // on black.
  const { html } = renderEmail({ preheader: "x", heading: "y", blocks: [{ p: "z" }] });
  assert.match(html, /<body style="[^"]*background:#F4EFE6/);
  assert.doesNotMatch(html, /<style/);
  assert.match(html, /name="color-scheme" content="light"/);
});
