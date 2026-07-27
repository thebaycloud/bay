import { config } from "./config";

// The Supersonic overlay injected into every hosted app's HTML:
//   - a "Runs on Supersonic" badge, bottom-right, for everyone
//   - a small owner toolbar (Share · Open in Supersonic), top-right, owners only
// Kept as one inline <style>+<div>+<a> block with a very high z-index so it sits
// above the app's own UI without needing the app to cooperate.

const APP = "https://app.supersonic.cv";
const SITE = "https://supersonic.cv";

function overlay(slug: string, owner: boolean): string {
  const toolbar = owner
    ? `<div id="ss-bar" style="position:fixed;top:12px;right:12px;z-index:2147483000;display:flex;gap:6px;align-items:center;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<a href="${APP}/apps/${slug}?tab=settings" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:#fff;color:#15140f;padding:8px 12px;border-radius:8px;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.14)">Share</a>
<a href="${APP}/apps/${slug}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;background:#15140f;color:#fff;padding:8px 12px;border-radius:8px;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.14)">Open in Supersonic</a>
</div>`
    : "";
  const badge = `<a href="${SITE}" target="_blank" id="ss-badge" style="position:fixed;bottom:16px;right:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;background:#0b5e38;color:#fff;font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:9px 13px;border-radius:8px;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.18)">
<svg width="11" height="11" viewBox="0 0 24 24" fill="#fff"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Runs on Supersonic</a>`;
  return `<div id="ss-overlay" data-nosnippet>${toolbar}${badge}</div>`;
}

/** Inject the overlay just before </body> (or append if there's no body tag). */
export function injectOverlay(htmlBody: string, slug: string, owner: boolean): string {
  const snippet = overlay(slug, owner);
  const idx = htmlBody.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return htmlBody + snippet;
  return htmlBody.slice(0, idx) + snippet + htmlBody.slice(idx);
}

/** True only for a top-level HTML document we should decorate. */
export function isHtmlDocument(contentType: string | undefined): boolean {
  return !!contentType && /text\/html/i.test(contentType) && config.injectOverlay;
}
