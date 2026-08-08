import { escapeHtml } from "./pages";
import { XRAY_CSS, XRAY_JS } from "./xray-panel";

/**
 * The x-ray as a page of its own, at the app's own `/_xray`.
 *
 * The panel normally rides the overlay injected into a hosted app's HTML, which
 * covers every app that has a page and no app that does not. An API answers `/`
 * with JSON — injecting into that body would stop it being JSON — so the owner
 * of an API-shaped app had no x-ray at all, which is precisely the owner who
 * most wants to know which endpoint is slow and who is calling it.
 *
 * Same address, same panel, same numbers; only the frame differs. A machine
 * asking for `/_xray` still gets JSON — the split is on Accept, so an agent and
 * a person can read the same URL and each get the form they can use.
 */
export function xrayPage(slug: string): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(slug)} — x-ray</title>
<style>
  body{margin:0;min-height:100vh;background:#15140f;color:#eae8df;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
       display:flex;align-items:flex-start;justify-content:center;padding:28px 16px}
  ${XRAY_CSS}
  /* On a page of its own the panel is the content, not something floating over
     an app, so it drops the fixed position it needs inside the overlay. */
  .xr{position:static;width:min(560px,100%);max-height:none}
  a.back{display:block;width:min(560px,100%);margin:0 auto 12px;color:#7a786f;
         font:400 12px/1 ui-monospace,Menlo,monospace;text-decoration:none}
  a.back:hover{color:#eae8df}
</style>
<div>
  <a class="back" href="/">← ${escapeHtml(slug)}</a>
  <div id="root"></div>
</div>
<script>(function(){
var C={slug:${JSON.stringify(slug).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}};
var root=document.getElementById('root');
var pop=null;
function h(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
${XRAY_JS}
toggleXray();
})();</script>`;
}
