import { config } from "./config";
import { DRAWER_CSS, DRAWER_JS } from "./drawer";

// The Supersonic overlay injected into every hosted app's HTML. It renders inside
// a Shadow DOM so the app's own CSS can't reach it (no style bleed, no glow) and
// ours can't leak out. Everyone sees a "Runs on Supersonic" badge; owners also get
// a separated toolbar (Share · Open in Supersonic), and Share edits access inline.

const APP = "https://app.supersonic.cv";
const SITE = "https://supersonic.cv";

/**
 * Everything only an owner may see — as SOURCE, not as a runtime branch.
 *
 * This used to be one script with `if(!C.owner)return;` in the middle, which
 * meant every visitor to every hosted app was served the entire owner toolbar,
 * the share editor and the x-ray panel as text, and simply never ran them. The
 * gate worked; the secrecy did not. A visitor could read /_xray out of the page
 * and learn a private surface exists — and paid for the bytes of a feature they
 * can never use, on every page view.
 */
const OWNER_CSS = String.raw`.bar{position:fixed;top:14px;right:14px;display:flex;align-items:center;gap:8px;background:#15140f;color:#fff;padding:6px 6px 6px 14px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.28);z-index:2147483000}
.bar .brand{font:600 12px/1 sans-serif;letter-spacing:.02em;color:#cfcfc7;display:flex;align-items:center;gap:6px}
.bar button{font:600 12.5px/1 sans-serif;border:0;cursor:pointer;padding:8px 13px;border-radius:8px}
.bar .share{background:#2ea86a;color:#05130b}
.bar .open{background:#2b2a26;color:#fff;text-decoration:none;display:inline-flex;align-items:center}
.pop{position:fixed;top:58px;right:14px;width:300px;background:#1c1b18;color:#eae8df;border:1px solid #35342e;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:2147483000;overflow:hidden}
.pop h4{margin:0;padding:12px 14px;font:600 12px/1 sans-serif;border-bottom:1px solid #2a2925;color:#eae8df}
.opt{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;padding:10px 12px;cursor:pointer;color:#eae8df}
.opt:hover{background:#232219}.opt.on{background:#17281f}
.opt .l{font:600 13px/1.2 sans-serif}.opt .d{font:400 11px/1.3 sans-serif;color:#9c9a8f;margin-top:2px}
.opt .g{flex:1}.opt .ck{color:#2ea86a}
.people{border-top:1px solid #2a2925;padding:10px 12px}
.people input{width:100%;padding:7px 9px;background:#111;border:1px solid #35342e;color:#fff;border-radius:6px;font:400 12px sans-serif;outline:none}
.people .row{display:flex;align-items:center;justify-content:space-between;font:400 12px sans-serif;padding:6px 2px;color:#cfcfc7}
.people .rm{background:none;border:0;color:#7a786f;cursor:pointer}
.reqs{border:1px solid #1f3a2b;background:#12241a;margin:8px 10px}
.reqs h5{margin:0;padding:8px 10px 4px;font:600 10.5px sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#2ea86a}
.reqs .r{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;font:400 12px sans-serif;color:#eae8df}
.reqs .r .e{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reqs .r .a{display:flex;gap:6px;flex:none}
.reqs .ap{background:#2ea86a;color:#05130b;border:0;border-radius:6px;padding:5px 10px;font:600 11px sans-serif;cursor:pointer}
.reqs .dn{background:none;border:0;color:#9db0a6;cursor:pointer;font:400 11px sans-serif}
.bar .xray{background:#2b2a26;color:#fff}
${DRAWER_CSS}`;

const OWNER_JS = String.raw`
// toolbar (owner)
var bar=h('div','bar');
var brand=h('div','brand');brand.innerHTML=MARK(12,'#2ea86a')+'Supersonic';
var share=h('button','share','Share');
var xrayBtn=h('button','xray','Dashboard');
var open=document.createElement('a');open.className='open';open.href=C.app+'/apps/'+C.slug;open.target='_blank';open.textContent='Open in Supersonic';
bar.appendChild(brand);bar.appendChild(xrayBtn);bar.appendChild(share);bar.appendChild(open);root.appendChild(bar);

var pop=null;
var OPTS=[['private','Only me','Just you can open it'],['shared','Specific people','People you invite by email'],['public','Public','Anyone with the link']];
function api(body){return fetch(C.app+'/api/apps/'+C.slug+'/share',{method:body?'POST':'GET',credentials:'include',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json()});}
function render(){
  if(!pop)return;
  pop.innerHTML='';
  pop.appendChild(h('h4',null,'Who can open this app'));
  if(reqs.length){
    var rq=h('div','reqs');rq.appendChild(h('h5',null,'Access requests'));
    reqs.forEach(function(em){
      var row=h('div','r');row.appendChild(h('span','e',em));
      var a=h('div','a');
      var ap=h('button','ap','Approve');ap.onclick=function(){api({addEmail:em}).then(function(j){vis=j.visibility;grants=j.grants||[];reqs=j.requests||[];render();});};
      var dn=h('button','dn','Deny');dn.onclick=function(){api({denyEmail:em}).then(function(j){vis=j.visibility;grants=j.grants||[];reqs=j.requests||[];render();});};
      a.appendChild(ap);a.appendChild(dn);row.appendChild(a);rq.appendChild(row);
    });
    pop.appendChild(rq);
  }
  OPTS.forEach(function(o){
    var b=h('button','opt'+(vis===o[0]?' on':''));
    var g=h('div','g');g.appendChild(h('div','l',o[1]));g.appendChild(h('div','d',o[2]));
    b.appendChild(g);
    if(vis===o[0]){var ck=h('span','ck','✓');b.appendChild(ck);}
    b.onclick=function(){api({visibility:o[0]}).then(function(j){vis=j.visibility;grants=j.grants||[];reqs=j.requests||[];render();});};
    pop.appendChild(b);
  });
  if(vis==='shared'){
    var ppl=h('div','people');
    var inp=document.createElement('input');inp.type='email';inp.placeholder='colleague@company.com';
    inp.onkeydown=function(e){if(e.key==='Enter'&&inp.value){api({addEmail:inp.value}).then(function(j){vis=j.visibility;grants=j.grants||[];reqs=j.requests||[];render();});}};
    ppl.appendChild(inp);
    grants.forEach(function(gr){var row=h('div','row');row.appendChild(h('span',null,gr));var rm=h('button','rm','remove');rm.onclick=function(){api({removeEmail:gr}).then(function(j){vis=j.visibility;grants=j.grants||[];reqs=j.requests||[];render();});};row.appendChild(rm);ppl.appendChild(row);});
    pop.appendChild(ppl);
  }
}
share.onclick=function(){
  if(pop){pop.remove();pop=null;return;}
  pop=h('div','pop');root.appendChild(pop);render();
  api().then(function(j){if(j&&j.visibility){vis=j.visibility;grants=j.grants||[];reqs=j.requests||[];render();}});
};

${DRAWER_JS}
xrayBtn.onclick=openDrawer;
// A key as well as a button, because the point of this layer is that it is one
// gesture away from the app rather than a place you navigate to.
document.addEventListener('keydown',function(e){
  if(e.key==='x'&&(e.metaKey||e.ctrlKey)&&e.shiftKey){ e.preventDefault(); openDrawer(); }
  if(e.key==='Escape'&&dw){ closeDrawer(); }
});
`;

/** A self-contained script that builds the overlay in a shadow root. */
function overlayScript(slug: string, owner: boolean, badge: boolean): string {
  // slug is validated [a-z0-9-] upstream; JSON.stringify guards the rest.
  const cfg = JSON.stringify({ slug, owner, badge, app: APP, site: SITE });
  return `<script>(function(){
var C=${cfg};
if(window.__ssOverlay)return; window.__ssOverlay=1;
var host=document.createElement('div'); host.id='ss-overlay';
host.style.cssText='all:initial';
// THE OVERLAY HAS TO SURVIVE THE APP HYDRATING.
//
// This is injected before </body> and runs at parse time, so the node is in the
// body before the tenant's own JavaScript starts. A Next.js App Router app then
// calls hydrateRoot(document, ...) — React owns the WHOLE document, body's
// children included — finds a child it did not render, and reconciles it away.
// The toolbar and the badge go with it. Nothing errors; the overlay is simply
// gone a moment after it appeared, and the analytics tag beside it survives
// because a script that has already fired its request does not care.
//
// So attaching once is not enough: put it back whenever it leaves. The observer
// watches body's own child list only — not the subtree — because the removal we
// care about is exactly one mutation of exactly that list, and a subtree
// observer on somebody else's app is a cost we would be charging them forever.
function ssAttach(){
  var p=document.body||document.documentElement;
  if(p && host.parentNode!==p) p.appendChild(host);
}
ssAttach();
if(window.MutationObserver&&document.body){
  new MutationObserver(function(){ ssAttach(); }).observe(document.body,{childList:true});
}
// Belt and braces for the frameworks that swap the body wholesale rather than
// mutate it, which no observer bound to the old body would ever hear about.
document.addEventListener('DOMContentLoaded',ssAttach);
window.addEventListener('load',ssAttach);
var root=host.attachShadow({mode:'open'});
var css=\`
/* The base font sits on :host so it INHERITS. It used to sit on the universal
   selector, which reaches every element directly — and a direct rule beats an
   inherited one, so a child of something mono (the state dot's label, a value in
   a tint row) was silently pulled back to the sans face no matter what its
   parent asked for. The panel is built out of exactly that kind of nesting.

   NOTHING IN THIS BLOCK MAY CONTAIN A BACKTICK. It is emitted inside a JS
   template literal, so one closes the string early: this comment did, and the
   browser then evaluated "...sit on " * ", which..." — string times string —
   assigned NaN to the stylesheet, and rendered the whole overlay unstyled as
   plain text six thousand pixels down the page. No syntax error, no warning,
   nothing in the console. There is a test below that keeps this honest. */
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
*{box-sizing:border-box}
.badge{position:fixed;bottom:16px;right:16px;display:inline-flex;align-items:center;gap:6px;background:#0b5e38;color:#fff;font:600 12px/1 sans-serif;padding:9px 13px;border-radius:8px;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.18);z-index:2147483000}
${owner ? OWNER_CSS : ""}\`;
// Supersonic mark — the knockout drawing, since it is always light-on-dark here.
// Mirrors apps/*/components/Mark.tsx; see docs/BRAND.md before changing.
function MARK(px,fill){return '<svg width="'+px+'" height="'+px+'" viewBox="0 0 24 24" fill="'+fill+'">'
  +'<path d="M7.4 1.5 L14.2 1.5 L7.2 22.5 L0.4 22.5 Z"/>'
  +'<path d="M16.8 1.5 L23.6 1.5 L16.6 22.5 L9.8 22.5 Z"/></svg>';}
var vis='private',grants=[],reqs=[];
function h(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
var style=document.createElement('style');style.textContent=css;root.appendChild(style);

// badge (everyone on free; removable on paid plans)
if(C.badge){
var badge=document.createElement('a');badge.className='badge';badge.href=C.site;badge.target='_blank';
badge.innerHTML=MARK(12,'#fff')+'Runs on Supersonic';
root.appendChild(badge);
}

${owner ? OWNER_JS : ""}
})();</script>`;
}

/**
 * The analytics tracker, for EVERY visitor.
 *
 * Outside `overlayScript` entirely, and that placement is the point. Everything
 * in there is behind `owner ? OWNER_JS : ""` because an owner-only surface a
 * visitor can read in the page source is not owner-only. This is the opposite
 * kind of thing: it must run for the anonymous visitor, who is the only visitor
 * most of these apps have, and it must give away nothing about the panel while
 * doing it. A reader of the source sees two paths on the app's own origin and
 * an opaque id, which is all there is to see.
 *
 * `defer`, so it never blocks the app's own render. Umami follows
 * `history.pushState` on its own, which is what closes the client-side-routing
 * gap the edge cannot see: a single-page app's second screen is a request the
 * proxy never hears about and a page view a person definitely had.
 */
function trackerTag(websiteId: string): string {
  return `<script defer src="/_bay/a.js" data-website-id="${JSON.stringify(websiteId).slice(1, -1)}" data-host-url="/_bay"></script>`;
}

/**
 * Inject whatever this response has earned, just before </body>.
 *
 * Order matters only in that the tracker goes first: it is the thing that has
 * to run on a page the overlay may have no business on at all.
 */
export function injectOverlay(
  htmlBody: string,
  slug: string,
  owner: boolean,
  badge: boolean,
  websiteId?: string | null,
): string {
  const snippet =
    (websiteId ? trackerTag(websiteId) : "") +
    (hasOverlay(owner, badge) ? overlayScript(slug, owner, badge) : "");
  if (!snippet) return htmlBody;
  const idx = htmlBody.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return htmlBody + snippet;
  return htmlBody.slice(0, idx) + snippet + htmlBody.slice(idx);
}

/**
 * Whether there is anything to inject at all.
 *
 * A paid app being viewed by a stranger has no badge and no toolbar, so the
 * overlay would be an empty shadow root — and buffering the entire HTML
 * response to add nothing is a real cost on the one path where it is charged to
 * every page view. This is what lets `forward` stream those responses through
 * untouched, exactly like a Pro customer's app should behave.
 */
export function hasOverlay(owner: boolean, badge: boolean): boolean {
  return owner || badge;
}

/**
 * Whether this response has to be buffered.
 *
 * The overlay was the only reason to buffer, so this used to be `hasOverlay`
 * alone at the call site. A Pro customer's app shown to a stranger now has a
 * second reason — it is the app whose owner most wants to know who is visiting
 * — and reading `hasOverlay` there would have quietly given analytics to
 * everyone EXCEPT the people paying for it.
 */
export function needsBody(owner: boolean, badge: boolean, websiteId?: string | null): boolean {
  return hasOverlay(owner, badge) || Boolean(websiteId);
}

/** True only for a top-level HTML document we should decorate. */
export function isHtmlDocument(contentType: string | undefined): boolean {
  return !!contentType && /text\/html/i.test(contentType) && config.injectOverlay;
}
