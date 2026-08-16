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
  /* Full width of the column rather than its own 560px: the column already is
     560px, and two independent width rules is how one of them ends up wrong. */
  .xr{position:static;width:100%;max-height:none}
  .col{width:min(560px,100%);margin:0 auto}
  .top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 12px}
  .top .door{color:#eae8df;font:400 13px/1 ui-monospace,Menlo,monospace;text-decoration:none}
  .top .door:hover{color:#2ea86a}
  .top .out{color:#7a786f;font:400 11.5px/1 sans-serif;text-decoration:none;flex:none}
  .top .out:hover{color:#eae8df}
  /* The half that has not moved yet, named rather than hidden. An owner who
     came here for their app's data should be told where it is, not left to
     guess that this page is all there is. */
  .rest{margin:14px 0 0;color:#7a786f;font:400 11.5px/1.6 sans-serif}
  .rest a{color:#9c9a8f;text-decoration:none;border-bottom:1px solid #35342e}
  .rest a:hover{color:#eae8df}
</style>
<div class="col">
  <div class="top">
    <!-- The address, and it goes there. This page is about the app; the one
         link every reader wants from it is the app itself. -->
    <a class="door" href="/">${escapeHtml(slug)}.supersonic.cv →</a>
    <a class="out" href="https://app.supersonic.cv">All apps</a>
  </div>
  <div id="root"></div>
  <p class="rest">Its data, files, jobs and secrets are still on
    <a href="https://app.supersonic.cv/apps/${escapeHtml(slug)}">supersonic.cv</a>.</p>
</div>
<script>(function(){
// C.app as well as C.slug: the panel's analytics switch posts to the control
// plane, and on this page — unlike inside the overlay, which builds C itself —
// there was nothing telling it where that is. A missing value here is a button
// that fetches "undefined/api/..." and fails silently.
var C={slug:${JSON.stringify(slug).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")},app:"https://app.supersonic.cv"};
var root=document.getElementById('root');
var pop=null;
function h(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
${XRAY_JS}
toggleXray();
})();</script>`;
}
