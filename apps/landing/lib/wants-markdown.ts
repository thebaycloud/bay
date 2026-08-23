/**
 * Whether this request came from something that reads text, not something that
 * paints a page.
 *
 * The landing page at the root is written for a person: a picture, a headline,
 * a globe. The same address typed into a terminal — `curl thebay.cloud` — is
 * almost never a person and never a browser; it is an agent, or the human
 * driving one, asking the shortest possible question: what is this and how do I
 * use it. Thirty-eight kilobytes of markup answers that badly. The manual we
 * already keep at `/llms.txt` answers it exactly, so the root serves that
 * instead when the client is one of these.
 *
 * The rule is deliberately conservative, because the cost of the two mistakes
 * is not symmetric. Serving markdown to a browser breaks the marketing site;
 * serving HTML to a curl leaves someone one path away from what they wanted.
 * So: a client that says it accepts HTML gets HTML, always — that covers every
 * browser, and it covers the link-preview crawlers (Slack, Twitter, Facebook,
 * iMessage), which send a wildcard Accept but exist to read the og: tags in
 * the head of the document.
 * Only an explicit ask for markdown, an explicit ask for plain text, or a
 * user-agent that is unmistakably a command-line HTTP client gets the manual.
 */

/**
 * Command-line HTTP clients and the libraries an agent shells out through.
 * Word-bounded so `curlie` matches and `mycurl-browser` does not, and kept to
 * names that no browser ever sends. `node` is on it because that is the exact
 * user-agent Node's own `fetch` sends, which is what most agent tooling is —
 * and it can only be reached by a client that did not ask for HTML.
 */
const TERMINAL_CLIENT =
  /\b(curl|libcurl|wget|httpie|xh|python-requests|urllib|httpx|aiohttp|node|nodejs|node-fetch|undici|axios|bun|deno|go-http-client|okhttp|powershell|lwp::simple|http_request2)\b/i;

export function wantsMarkdown(accept: string | null, userAgent: string | null): boolean {
  const a = (accept ?? "").toLowerCase();

  // An explicit ask wins over everything, including a browser's own defaults —
  // `curl -H 'Accept: text/markdown'` is a request, not a hint.
  if (a.includes("text/markdown") || a.includes("text/x-markdown")) return true;

  // Anything that will render HTML gets HTML. This is the branch that protects
  // the marketing site, and it is checked before the user-agent so that a
  // headless browser driving a screenshot still sees the page it is there for.
  if (a.includes("text/html")) return false;

  if (a.startsWith("text/plain")) return true;

  return TERMINAL_CLIENT.test(userAgent ?? "");
}
