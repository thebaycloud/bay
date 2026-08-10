/**
 * The x-ray panel, once, for the two places it appears.
 *
 * It began as part of the overlay injected into a hosted app's HTML — which
 * works right up until the app has no HTML. The CRM example answers `/` with
 * `{"contacts":1,"ok":true}`, and an owner of an API-shaped app got no panel at
 * all: exactly the owner who most wants to know which of their endpoints is
 * slow and who is calling them. Injecting into a JSON body is not an option —
 * it would stop being JSON.
 *
 * So the same panel is also served as a page at the app's own `/_xray`, and both
 * places import it from here. Two copies would drift within a week, and the one
 * that drifted would be the one nobody was looking at.
 */

/** Styles for the panel itself. Scoped by `.xr`, so it is safe in a shadow root
 *  and safe on a page of its own. */
export const XRAY_CSS = String.raw`.xr{position:fixed;top:58px;right:14px;width:390px;max-height:70vh;overflow:auto;background:#1c1b18;color:#eae8df;border:1px solid #35342e;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:2147483000}
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
`;

/**
 * The panel's behaviour: draw a reading, and poll for the next one.
 *
 * Written against three names the host must provide — `h(tag, class, text)` for
 * elements, `C.slug` for the title, and a `root` to append into — because the
 * overlay already had all three and duplicating them would have been the first
 * thing to drift.
 */
export const XRAY_JS = String.raw`// ---- x-ray: what this app is doing right now ----
//
// Owner-only, and read-only. The numbers come from the edge, which sees every
// request to every hosted app, so the owner instruments nothing and a visitor
// can never tell this exists.
var xr=null,xrTimer=null;
// Builds are durable and the live half is not, so this has to reach further
// than it once did: zpjsb has been in flight since 2 Aug, and "216h" is not a
// reading. ago() is defined through dur() rather than beside it, so the two
// cannot disagree about where an hour ends.
function dur(sec){ if(sec<60)return sec+'s'; if(sec<3600)return Math.round(sec/60)+'m'; if(sec<86400)return Math.round(sec/3600)+'h'; return Math.round(sec/86400)+'d'; }
function ago(sec){ return dur(sec)+' ago'; }
function clock(ms){ var d=new Date(ms); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
function sec(title){ var e=document.createElement('sec'); e.appendChild(h('div','k',title)); return e; }

function drawXray(d){
  if(!xr)return;
  // The panel is one rendering of the reading; d.live is the same shape this
  // used to receive whole, back when /_xray answered with the live half only.
  var live=d.live;
  xr.innerHTML='';
  var head=h('h4'); head.appendChild(h('span',null,'X-ray · '+C.slug));
  head.appendChild(h('span','since','watching since '+clock(d.since.live)));
  xr.appendChild(head);

  // who's here
  var s1=sec("Who's here");
  if(!live.here.count){ s1.appendChild(h('div','none','Nobody is in this app right now.')); }
  else {
    var line=h('div','who'); line.textContent=live.here.count===1?'1 person':live.here.count+' people';
    if(live.here.names.length){ var n=h('span','n',' — '+live.here.names.join(', ')); line.appendChild(n); }
    if(live.here.names.length<live.here.count){
      var rest=live.here.count-live.here.names.length;
      line.appendChild(h('span','n',(live.here.names.length?', ':' — ')+rest+' not signed in'));
    }
    s1.appendChild(line);
  }
  xr.appendChild(s1);

  // speed
  var s2=sec('Speed');
  if(!live.paths.length){
    // Empty is not zero. The edge only remembers since it last started, and a
    // panel that showed "0 requests" after a release would be lying.
    s2.appendChild(h('div','none','Nothing has been asked of this app since '+clock(d.since.live)+'.'));
  } else {
    var t=document.createElement('table');
    live.paths.slice(0,12).forEach(function(p){
      var tr=document.createElement('tr');
      var td1=h('td','p',p.path);
      var td2=h('td','n'+(p.p95>=1000?' slow':''),p.p95+'ms');
      var td3=h('td','n',p.hits+'×');
      var td4=h('td','n'+(p.errors?' bad':''),p.errors?p.errors+' failed':ago(p.ago));
      tr.appendChild(td1);tr.appendChild(td2);tr.appendChild(td3);tr.appendChild(td4);
      t.appendChild(tr);
    });
    s2.appendChild(t);
    if(live.dropped) s2.appendChild(h('div','drop',live.dropped+' more paths seen than this keeps — the busiest are shown.'));
  }
  xr.appendChild(s2);

  // breaks
  var bad=live.paths.filter(function(p){return p.errors>0});
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

  // what happened
  //
  // The durable half. Four states, and the order they are tested in is the
  // design: each has its own words, and none is allowed to borrow another's.
  var s4=sec('What happened');
  if(!d.builds){
    // Not read yet. The placeholder toggleXray paints carries no builds key,
    // and inventing an empty list for it would draw "never been built" over an
    // app that has shipped a hundred times, for one frame, every time the panel
    // opens. This branch also absorbs an older-shaped object, which is how the
    // live half broke once already.
    s4.appendChild(h('div','none','Reading...'));
  } else if(d.since.builds==='unreadable'){
    // Never flattened into an empty list. A database that will not answer is
    // not a fact about this app, and the window beside the list exists to keep
    // those two apart.
    s4.appendChild(h('div','none','Could not read the build history for this app.'));
  } else if(!d.builds.length){
    s4.appendChild(h('div','none','This app has never been built.'));
  } else {
    var t3=document.createElement('table');
    var bnow=Date.now();
    d.builds.slice(0,8).forEach(function(b){
      var since=Math.round((bnow-b.startedAt)/1000);
      var tr=document.createElement('tr');
      tr.appendChild(h('td','p',ago(since)));
      // Printed verbatim: you, agent, platform, someone. "someone" means nobody
      // said, and dressing it up as anything else is the one thing this column
      // must never do.
      tr.appendChild(h('td','n',b.who));
      var out,cls;
      if(b.outcome==='ok'){ out='ok'; cls='n'; }
      else if(b.outcome==='failed'){ out='failed'; cls='n bad'; }
      // Elapsed rather than a spinner: a build stuck for a week should look
      // wrong, not busy.
      else if(b.endedAt===null){ out='in flight, '+dur(since); cls='n'; }
      // Ended without an outcome should be impossible. It is drawn, and drawn
      // as bad, because the alternative is that it reads as success.
      else { out='ended, unrecorded'; cls='n bad'; }
      if(b.linesGone) out+=' · lines pruned';
      tr.appendChild(h('td',cls,out));
      t3.appendChild(tr);
    });
    s4.appendChild(t3);
  }
  xr.appendChild(s4);
}

function pullXray(){
  // Never swallowed. A mismatch between what /_xray serves and what drawXray
  // reads throws here, and an empty catch turns that into a panel that drew
  // once and stopped -- a healthy 200 in the network tab and nothing anywhere
  // else. Reporting it costs a line and is the only signal this surface has.
  fetch('/_xray',{credentials:'include'}).then(function(r){return r.json()}).then(drawXray).catch(function(e){console.error('x-ray:',e)});
}
function toggleXray(){
  if(xr){ xr.remove(); xr=null; clearInterval(xrTimer); xrTimer=null; return; }
  if(pop){ pop.remove(); pop=null; }
  xr=h('div','xr'); root.appendChild(xr);
  drawXray({since:{live:Date.now()},live:{here:{count:0,names:[]},paths:[],dropped:0}});
  pullXray();
  xrTimer=setInterval(pullXray,3000);
}
`;
