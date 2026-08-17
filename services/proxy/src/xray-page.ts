import { escapeHtml } from "./pages";
import { DRAWER_CSS, DRAWER_JS } from "./drawer";

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
<title>${escapeHtml(slug)} — dashboard</title>
<style>
  body{margin:0;min-height:100vh;background:#E5E5E2;color:#1A1A19;
       font-family:'Geist',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
       display:flex;align-items:flex-start;justify-content:center;padding:28px 16px}
  ${DRAWER_CSS}
  /* On a page of its own the panel is the content, not something sliding over
     an app, so the flat modifier drops the fixed position, the transform and the
     shadow it needs inside the overlay. Height comes from the column, because
     the panel is a flex column whose scroller expects a bounded parent. */
  .col{width:min(720px,100%);margin:0 auto;height:calc(100vh - 56px);
       display:flex;flex-direction:column;gap:12px}
  #root{flex:1;min-height:0;border-radius:12px;overflow:hidden;
        box-shadow:0 1px 2px rgba(38,38,38,.06),0 18px 50px -24px rgba(38,38,38,.3)}
  .top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex:none}
  .top .door{color:#1A1A19;font:400 13px/1 ui-monospace,Menlo,monospace;text-decoration:none}
  .top .door:hover{color:#B32C1A}
  .top .out{color:#8A8A86;font:400 11.5px/1 sans-serif;text-decoration:none;flex:none}
  .top .out:hover{color:#1A1A19}
</style>
<div class="col">
  <div class="top">
    <!-- The address, and it goes there. This page is about the app; the one
         link every reader wants from it is the app itself. -->
    <a class="door" href="/">${escapeHtml(slug)}.supersonic.cv →</a>
    <a class="out" href="https://app.supersonic.cv">All apps</a>
  </div>
  <div id="root"></div>
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
${DRAWER_JS}
// Flat: on a page of its own the panel is the content, not something sliding
// over an app, so it neither slides nor needs a way to be dismissed.
//
// No tab is selected any more. This used to ask for 'xray' by name, back when
// the panel opened onto a row of tabs; it opens onto home now, and home is the
// whole thing — the live feed included, as the cell that takes the leftover
// height. buildDrawer already renders and then re-renders when the data lands.
root.appendChild(buildDrawer(true));
})();</script>`;
}
