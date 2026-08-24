import { config } from "./config";

// The Supersonic overlay injected into every hosted app's HTML. It renders inside
// a Shadow DOM so the app's own CSS can't reach it (no style bleed, no glow) and
// ours can't leak out. Everyone sees a "Runs on <product>" badge; owners also get
// a separated toolbar (Share · Open in Supersonic), and Share edits access inline.

// Read from the same root the rest of the edge uses. This markup is injected
// into other people's pages, so a stale literal here is our old brand showing
// up on somebody's live site after the rename.
//
// `rootDomains[0]` — CANONICAL, and the singular `config.rootDomain` this said
// until now does not exist on config at all. TypeScript had been reporting it
// since the multi-root cutover; at runtime it is `undefined`, so every badge and
// every toolbar link injected into somebody else's page pointed at
// `https://app.undefined`. Two dead links on other people's live sites, from a
// property name that changed under a module nobody typechecked in CI.
const APP = `https://app.${config.rootDomains[0]}`;
const SITE = `https://${config.rootDomains[0]}`;

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
/**
 * Everything only an owner may see — as SOURCE, not as a runtime branch.
 *
 * This used to be one script with `if(!C.owner)return;` in the middle, which meant
 * every visitor to every hosted app was served the entire owner toolbar, the share
 * editor and the panel as text, and simply never ran them. The gate worked; the
 * secrecy did not.
 *
 * What is left is a pill. The panel it used to open moved to
 * app.supersonic.cv/apps/<slug>, so an owner's own app page no longer carries a
 * dashboard at all — it carries a link to one. Two things follow from that and both
 * are the point: an owner downloads a few hundred bytes instead of a panel on every
 * page of their own app, and there is almost nothing left in a tenant's document for
 * a visitor to read.
 *
 * A white pill rather than the old dark bar with square buttons, which was the last
 * thing in the product that looked like the previous one — and it says the app's
 * name and state, so it explains itself instead of being a button you have to
 * already know about.
 */
const OWNER_CSS = String.raw`.pill{position:fixed;top:14px;right:14px;z-index:2147483000;
  display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 13px;
  background:#fff;border:1px solid #E5E5E5;border-radius:999px;
  box-shadow:0 2px 10px rgba(0,0,0,.10);text-decoration:none;
  font:500 13px/1 'Geist',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0A0A0A}
.pill:hover{background:#FAFAFA}
.pill i{width:6px;height:6px;border-radius:50%;background:#A1A1AA;flex:none}
.pill i.ok{background:#16A34A}
.pill i.bad{background:#E63F2C}
.pill s{font:400 11px/1 'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace;
  letter-spacing:.06em;color:#737373;text-decoration:none}`;

const OWNER_JS = String.raw`
// The pill. A link to the workbench, saying which app this is and how it is doing.
var pill=document.createElement('a');
pill.className='pill';
pill.href=C.app+'/apps/'+C.slug;
pill.target='_blank';
pill.rel='noreferrer';
var dot=h('i');
var name=h('span',null,C.slug);
var state=document.createElement('s');
state.textContent='checking';
pill.appendChild(dot);pill.appendChild(name);pill.appendChild(state);
root.appendChild(pill);

// One read, same-origin, on idle. The panel used to fan out nine of these; a pill
// needs one word, and /_xray already answers it for the owner and nobody else.
// requestIdleCallback so it never competes with the tenant app's own load — and
// this is owner-only, so it costs a visitor nothing at all.
function ssState(){
  fetch('/_xray',{credentials:'include',headers:{Accept:'application/json'}})
    .then(function(r){return r.json()})
    .then(function(j){
      var paths=(j&&j.live&&j.live.paths)||[];
      var broken=false;
      for(var i=0;i<paths.length;i++){ if(paths[i].brokenFor){broken=true;break;} }
      // The panel's own words, and its own rule: green is status and nothing else,
      // so a broken path is the one thing wearing the accent.
      if(broken){ dot.className='bad'; state.textContent='broken'; return; }
      dot.className='ok'; state.textContent='afloat';
    })
    .catch(function(){
      // A pill that cannot reach the reading says nothing rather than guessing.
      // It is still a working link, which is the part that matters.
      state.textContent='';
    });
}
if(window.requestIdleCallback) requestIdleCallback(ssState); else setTimeout(ssState,2000);
`;

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
badge.innerHTML=MARK(12,'#fff')+'Runs on ${config.productName}';
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
