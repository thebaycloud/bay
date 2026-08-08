import { config } from "./config";

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
.xr{position:fixed;top:58px;right:14px;width:390px;max-height:70vh;overflow:auto;background:#1c1b18;color:#eae8df;border:1px solid #35342e;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:2147483000}
.xr h4{margin:0;padding:12px 14px;font:600 12px/1 sans-serif;border-bottom:1px solid #2a2925;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.xr h4 .since{font:400 10.5px sans-serif;color:#7a786f}
.xr sec{display:block;border-bottom:1px solid #2a2925;padding:10px 14px}
.xr sec:last-child{border-bottom:0}
.xr .k{font:600 10.5px sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#2ea86a;margin-bottom:7px}
.xr .who{font:400 12.5px/1.5 sans-serif;color:#eae8df}
.xr .who .n{color:#9c9a8f}
.xr table{width:100%;border-collapse:collapse;font:400 11.5px/1.4 ui-monospace,Menlo,monospace}
.xr td{padding:3px 0;vertical-align:top}
.xr td.p{color:#eae8df;word-break:break-all;padding-right:8px}
.xr td.n{text-align:right;color:#9c9a8f;white-space:nowrap;padding-left:8px}
.xr td.slow{color:#f0c674}
.xr td.bad{color:#d1615d}
.xr .none{font:400 12px/1.5 sans-serif;color:#9c9a8f}
.xr .drop{font:400 10.5px sans-serif;color:#7a786f;margin-top:6px}
.bar .xray{background:#2b2a26;color:#fff}
`;

const OWNER_JS = String.raw`
// toolbar (owner)
var bar=h('div','bar');
var brand=h('div','brand');brand.innerHTML=MARK(12,'#2ea86a')+'Supersonic';
var share=h('button','share','Share');
var xrayBtn=h('button','xray','X-ray');
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

// ---- x-ray: what this app is doing right now ----
//
// Owner-only, and read-only. The numbers come from the edge, which sees every
// request to every hosted app, so the owner instruments nothing and a visitor
// can never tell this exists.
var xr=null,xrTimer=null;
function ago(sec){ if(sec<60)return sec+'s ago'; if(sec<3600)return Math.round(sec/60)+'m ago'; return Math.round(sec/3600)+'h ago'; }
function clock(ms){ var d=new Date(ms); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
function sec(title){ var e=document.createElement('sec'); e.appendChild(h('div','k',title)); return e; }

function drawXray(d){
  if(!xr)return;
  xr.innerHTML='';
  var head=h('h4'); head.appendChild(h('span',null,'X-ray · '+C.slug));
  head.appendChild(h('span','since','watching since '+clock(d.since)));
  xr.appendChild(head);

  // who's here
  var s1=sec("Who's here");
  if(!d.here.count){ s1.appendChild(h('div','none','Nobody is in this app right now.')); }
  else {
    var line=h('div','who'); line.textContent=d.here.count===1?'1 person':d.here.count+' people';
    if(d.here.names.length){ var n=h('span','n',' — '+d.here.names.join(', ')); line.appendChild(n); }
    if(d.here.names.length<d.here.count){
      var rest=d.here.count-d.here.names.length;
      line.appendChild(h('span','n',(d.here.names.length?', ':' — ')+rest+' not signed in'));
    }
    s1.appendChild(line);
  }
  xr.appendChild(s1);

  // speed
  var s2=sec('Speed');
  if(!d.paths.length){
    // Empty is not zero. The edge only remembers since it last started, and a
    // panel that showed "0 requests" after a release would be lying.
    s2.appendChild(h('div','none','Nothing has been asked of this app since '+clock(d.since)+'.'));
  } else {
    var t=document.createElement('table');
    d.paths.slice(0,12).forEach(function(p){
      var tr=document.createElement('tr');
      var td1=h('td','p',p.path);
      var td2=h('td','n'+(p.p95>=1000?' slow':''),p.p95+'ms');
      var td3=h('td','n',p.hits+'×');
      var td4=h('td','n'+(p.errors?' bad':''),p.errors?p.errors+' failed':ago(p.ago));
      tr.appendChild(td1);tr.appendChild(td2);tr.appendChild(td3);tr.appendChild(td4);
      t.appendChild(tr);
    });
    s2.appendChild(t);
    if(d.dropped) s2.appendChild(h('div','drop',d.dropped+' more paths seen than this keeps — the busiest are shown.'));
  }
  xr.appendChild(s2);

  // breaks
  var bad=d.paths.filter(function(p){return p.errors>0});
  var s3=sec('Breaks');
  if(!bad.length) s3.appendChild(h('div','none','Nothing has failed.'));
  else {
    var t2=document.createElement('table');
    bad.slice(0,8).forEach(function(p){
      var tr=document.createElement('tr');
      tr.appendChild(h('td','p',p.path));
      tr.appendChild(h('td','n bad',p.errors+' of '+p.hits));
      tr.appendChild(h('td','n',ago(p.ago)));
      t2.appendChild(tr);
    });
    s3.appendChild(t2);
  }
  xr.appendChild(s3);
}

function pullXray(){
  fetch('/_xray',{credentials:'include'}).then(function(r){return r.json()}).then(drawXray).catch(function(){});
}
function toggleXray(){
  if(xr){ xr.remove(); xr=null; clearInterval(xrTimer); xrTimer=null; return; }
  if(pop){ pop.remove(); pop=null; }
  xr=h('div','xr'); root.appendChild(xr);
  drawXray({since:Date.now(),here:{count:0,names:[]},paths:[],dropped:0});
  pullXray();
  xrTimer=setInterval(pullXray,3000);
}
xrayBtn.onclick=toggleXray;
// A key as well as a button, because the point of this layer is that it is one
// gesture away from the app rather than a place you navigate to.
document.addEventListener('keydown',function(e){
  if(e.key==='x'&&(e.metaKey||e.ctrlKey)&&e.shiftKey){ e.preventDefault(); toggleXray(); }
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
host.style.cssText='all:initial'; (document.body||document.documentElement).appendChild(host);
var root=host.attachShadow({mode:'open'});
var css=\`
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
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

/** Inject the overlay script just before </body> (or append if there's no body). */
export function injectOverlay(htmlBody: string, slug: string, owner: boolean, badge: boolean): string {
  const snippet = overlayScript(slug, owner, badge);
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

/** True only for a top-level HTML document we should decorate. */
export function isHtmlDocument(contentType: string | undefined): boolean {
  return !!contentType && /text\/html/i.test(contentType) && config.injectOverlay;
}
