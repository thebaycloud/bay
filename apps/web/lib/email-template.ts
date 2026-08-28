/**
 * One template, every email.
 *
 * WHY BOTH BODIES COME FROM ONE DESCRIPTION
 *
 * An email needs an HTML part and a plaintext part, and the plaintext one is not
 * a courtesy: it is what a text-only client shows, what a screen reader is often
 * handed, and what spam filters compare against the HTML to decide whether the
 * two agree. Writing them separately means they drift, and the drift is
 * invisible because nobody reads the part their own client does not render.
 *
 * So callers describe the email as content — a heading, some paragraphs, maybe a
 * button — and both bodies are generated from that description. They cannot
 * disagree, because there is only one of them.
 *
 * WHY IT IS ALL TABLES AND INLINE STYLES
 *
 * Outlook renders with Word's engine: no flexbox, no grid, no `<style>` blocks
 * worth trusting, and margins that come and go. Gmail strips `<head>` entirely.
 * The intersection of what works everywhere is a table of one column with every
 * style written on the element, which is what this is. It looks like 2004 on
 * purpose.
 *
 * WHY THE LOGO IS A HOSTED PNG WITH ALT TEXT
 *
 * Gmail strips SVG completely, so the mark cannot be the `.svg` the app uses.
 * And most clients block remote images by default on first contact from a new
 * sender — which is precisely the state every one of these emails is sent in. So
 * the logo carries `alt="Bay"`: blocked, it degrades to the product's name in
 * the right place, rather than a broken-image box.
 */
import { controlPlaneUrl, productName } from "./brand";

/** The palette. Light, per the brief, and drawn from the logo itself. */
const C = {
  /** The logo's cream — the page behind the card. */
  page: "#F4EFE6",
  card: "#FFFFFF",
  /** International Orange, the mark's tile and the bridge's real colour. */
  accent: "#C63A22",
  text: "#1F1D1B",
  muted: "#6B655E",
  hair: "#E7E0D5",
  /** A quoted error or command block. Warm grey, never black-on-black. */
  code: "#F7F4EF",
} as const;

const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;

/** One paragraph of prose. */
export interface Para { p: string }
/** A quoted block: an error, a command, a fix prompt. Monospace, never wrapped. */
export interface Code { code: string; label?: string }
/** A labelled fact, rendered as a small two-column row. */
export interface Fact { key: string; value: string }

export type Block = Para | Code | { facts: Fact[] };

export interface EmailContent {
  /** The line a client shows next to the subject in the list. */
  preheader: string;
  heading: string;
  blocks: Block[];
  cta?: { label: string; url: string };
  /** Small print under the button — an expiry, or what to do if it wasn't you. */
  footnote?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isPara = (b: Block): b is Para => "p" in b;
const isCode = (b: Block): b is Code => "code" in b;

/**
 * Render one email.
 *
 * Returns both bodies. `sendEmail` passes both to the provider, and the client
 * picks — so an HTML-hostile inbox still gets a readable message rather than
 * markup.
 */
export function renderEmail(c: EmailContent): { html: string; text: string } {
  const base = controlPlaneUrl();
  const name = productName();

  const htmlBlocks = c.blocks
    .map((b) => {
      if (isPara(b)) {
        return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${C.text}">${esc(b.p)}</p>`;
      }
      if (isCode(b)) {
        const label = b.label
          ? `<div style="margin:0 0 6px;font-size:12px;color:${C.muted};text-transform:none">${esc(b.label)}</div>`
          : "";
        // `pre` with an explicit background, because a client that ignores the
        // background must still show dark text — the failure mode of a themed
        // code block is invisible text.
        return (
          `${label}<pre style="margin:0 0 16px;padding:12px 14px;background:${C.code};border:1px solid ${C.hair};` +
          `border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;` +
          `line-height:1.5;color:${C.text};white-space:pre-wrap;word-break:break-word">${esc(b.code)}</pre>`
        );
      }
      const rows = b.facts
        .map(
          (f) =>
            `<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:${C.muted};white-space:nowrap">${esc(f.key)}</td>` +
            `<td style="padding:4px 0;font-size:13px;color:${C.text}">${esc(f.value)}</td></tr>`,
        )
        .join("");
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px">${rows}</table>`;
    })
    .join("");

  // A "bulletproof button": a table cell with a background and a padded anchor.
  // A styled `<a>` alone loses its background in Outlook, and a real `<button>`
  // does not exist in mail at all.
  const cta = c.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px">
         <tr><td align="center" bgcolor="${C.accent}" style="border-radius:8px">
           <a href="${esc(c.cta.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};
              font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px">${esc(c.cta.label)}</a>
         </td></tr>
       </table>`
    : "";

  const footnote = c.footnote
    ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:${C.muted}">${esc(c.footnote)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(c.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<!-- Preview text. Hidden, then padded with zero-width joiners so the client does
     not pull the first line of the body in after it. -->
<div style="display:none;font-size:1px;color:${C.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">
${esc(c.preheader)}${"&#8204;&nbsp;".repeat(60)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}">
 <tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">

   <!-- Mark + wordmark -->
   <tr><td style="padding:0 4px 20px">
    <a href="${base}" style="text-decoration:none">
     <img src="${base}/email/logo.png" width="36" height="36" alt="${esc(name)}"
          style="display:inline-block;vertical-align:middle;border:0;border-radius:8px">
     <span style="display:inline-block;vertical-align:middle;padding-left:10px;font-family:${FONT};
           font-size:17px;font-weight:600;letter-spacing:-0.02em;color:${C.text}">${esc(name)}</span>
    </a>
   </td></tr>

   <!-- The card -->
   <tr><td style="background:${C.card};border:1px solid ${C.hair};border-radius:12px;padding:28px 28px 26px;font-family:${FONT}">
    <h1 style="margin:0 0 14px;font-size:20px;line-height:1.35;font-weight:600;letter-spacing:-0.02em;color:${C.text}">${esc(c.heading)}</h1>
    ${htmlBlocks}
    ${cta}
    ${footnote}
   </td></tr>

   <!-- Footer -->
   <tr><td style="padding:18px 6px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted}">
    <a href="${base}" style="color:${C.muted};text-decoration:underline">${esc(name)}</a>
    &nbsp;·&nbsp; Replies to this email reach a person.
   </td></tr>

  </table>
 </td></tr>
</table>
</body></html>`;

  // The same content, as text. Not a stripped version of the HTML — generated
  // from the same blocks, which is the point.
  const textBlocks = c.blocks.map((b) => {
    if (isPara(b)) return b.p;
    if (isCode(b)) return (b.label ? `${b.label}\n` : "") + b.code.split("\n").map((l) => `    ${l}`).join("\n");
    return b.facts.map((f) => `  ${f.key}  ${f.value}`).join("\n");
  });

  const text = [
    c.heading,
    "",
    ...textBlocks.flatMap((t) => [t, ""]),
    ...(c.cta ? [`${c.cta.label}:`, c.cta.url, ""] : []),
    ...(c.footnote ? [c.footnote, ""] : []),
    "—",
    `${name}  ${base}`,
    "Replies to this email reach a person.",
  ].join("\n");

  return { html, text };
}
