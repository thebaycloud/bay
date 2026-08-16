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
.xr .big{font:600 15px/1.3 sans-serif;color:#eae8df}
.xr .big .u{font:400 12px sans-serif;color:#9c9a8f}
.xr .up{color:#2ea86a}.xr .down{color:#d1615d}
.xr .sub{font:400 11.5px/1.5 sans-serif;color:#9c9a8f;margin-top:3px}
.xr .cols{display:flex;gap:14px;margin-top:9px}
.xr .cols>div{flex:1;min-width:0}
.xr .ch{font:600 10px sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#7a786f;margin-bottom:4px}
/* Three columns share the panel's width, so the shared word-break:break-all
   that keeps a long PATH readable in Speed is wrong here: a referrer hostname
   wrapped to "news.ycombinator.co / m" and pushed its own count onto the line
   above. Truncate instead of wrap, and fix the layout so one long value cannot
   steal width from the other two columns. */
.xr .cols table{table-layout:fixed;width:100%}
.xr .cols td.p{word-break:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.xr .cols td.n{width:40px}
.xr .kbar{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.xr .sw{background:none;border:0;padding:0;color:#7a786f;font:400 10.5px sans-serif;cursor:pointer;flex:none}
.xr .sw:hover{color:#eae8df}
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
      var td4=h('td','n'+(p.broke?' bad':''),p.broke?p.broke+' broke':ago(p.ago));
      tr.appendChild(td1);tr.appendChild(td2);tr.appendChild(td3);tr.appendChild(td4);
      t.appendChild(tr);
    });
    s2.appendChild(t);
    if(live.dropped) s2.appendChild(h('div','drop',live.dropped+' more paths seen than this keeps — the busiest are shown.'));
  }
  xr.appendChild(s2);

  // breaks
  // Only what the app itself failed. A request for a page that was never there
  // is somebody else's mistake, and while it shared a counter with this it was
  // every faviconless app's headline problem.
  var bad=live.paths.filter(function(p){return p.broke>0});
  var s3=sec('Breaks');
  if(!bad.length) s3.appendChild(h('div','none','Nothing has failed.'));
  else {
    var t2=document.createElement('table');
    bad.slice(0,8).forEach(function(p){
      var tr=document.createElement('tr');
      tr.appendChild(h('td','p',p.path));
      tr.appendChild(h('td','n bad',p.broke+' of '+p.hits));
      // Broken now, or broken once. Until the count carried a time these read
      // identically, and this morning's fixed outage outranked tonight's real
      // one for as long as the process lived.
      tr.appendChild(p.brokenFor!==null
        ? h('td','n bad','broken '+dur(p.brokenFor))
        : h('td','n','last broke '+ago(p.brokeAgo)));
      t2.appendChild(tr);
    });
    s3.appendChild(t2);
  }
  xr.appendChild(s3);

  // who visited
  //
  // The other half of the panel's question, and the only half that is about
  // PEOPLE. Everything above this line is the edge's own measurement of
  // machines: requests, milliseconds, status codes. This is umami's count of
  // humans over the last day, and the two are never added together, never
  // compared, and never drawn as the same number — one page view with eleven
  // assets on it is eleven requests up there and one visitor down here, and
  // both readings are correct.
  //
  // Four states again, tested in this order, each with its own words:
  // not asked yet, switched off, could not be read, and read.
  var aw=d.since&&d.since.audience;
  var s5=document.createElement('sec');
  var kbar=h('div','kbar');
  kbar.appendChild(h('div','k','Who visited · last 24h'));
  // The switch lives HERE, beside the numbers, and not three screens away in a
  // settings page. This is somebody else's users' data being counted; the person
  // who can decide that should meet the decision at the moment they are looking
  // at the result of it. Hidden only while the first read is still in flight,
  // because a control whose label would be a guess is worse than no control.
  if(aw){
    var sw=h('button','sw',aw==='off'?'turn on':'turn off');
    sw.onclick=function(){
      var want=aw==='off';
      sw.textContent='...';
      fetch(C.app+'/api/apps/'+C.slug+'/analytics',{
        method:'POST',credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({enabled:want})
      }).then(function(r){return r.json()}).then(function(j){
        // The edge caches app rows, so the next poll will still show the old
        // state for up to half a minute. Say so rather than letting the panel
        // look like it ignored the click.
        sw.textContent=j&&j.error?'could not change':(want?'on in a moment':'off in a moment');
      }).catch(function(){sw.textContent='could not change'});
    };
    kbar.appendChild(sw);
  }
  s5.appendChild(kbar);
  if(!aw){
    // The placeholder toggleXray paints has no audience key at all. Drawing
    // "nobody visited" over an app with a thousand visitors, for one frame,
    // every time the panel opens, is the same lie the builds half already
    // learned not to tell.
    s5.appendChild(h('div','none','Reading...'));
  } else if(aw==='off'){
    // Not a failure and not an empty app. Said plainly, because the owner is
    // the person who turned it off and should recognise their own decision.
    s5.appendChild(h('div','none','Analytics is off for this app.'));
  } else if(aw==='unreadable'){
    // Never flattened into zeroes. An analytics service that will not answer is
    // not a fact about this app's visitors.
    s5.appendChild(h('div','none','Could not read visitor numbers just now.'));
  } else if(!d.audience||!d.audience.visitors){
    s5.appendChild(h('div','none','Nobody has opened this app in the last day.'));
  } else {
    var a=d.audience;
    var big=h('div','big');
    big.appendChild(h('span',null,a.visitors===1?'1 person':a.visitors+' people'));
    // Only against a window that had somebody in it. The read side sends null
    // rather than 0 for a brand-new app, and "+0%" about a day that never
    // happened is exactly the kind of confident nonsense this panel avoids.
    if(a.change!==null&&a.change!==undefined){
      big.appendChild(h('span','u',' '));
      big.appendChild(h('span',a.change>=0?'up':'down',(a.change>=0?'+':'')+a.change+'%'));
    }
    big.appendChild(h('span','u',' · '+a.views+(a.views===1?' page view':' page views')));
    s5.appendChild(big);
    // Bounce and dwell are per SESSION, which is why they are phrased as
    // sentences about people rather than printed as bare percentages.
    s5.appendChild(h('div','sub',a.bounce+'% left after one page · '+dur(a.avgSeconds)+' each, on average'));

    var cols=h('div','cols');
    [['Pages',a.pages],['Came from',a.from],['On',a.on]].forEach(function(c){
      if(!c[1]||!c[1].length)return;
      var col=document.createElement('div');
      col.appendChild(h('div','ch',c[0]));
      var tb=document.createElement('table');
      c[1].slice(0,5).forEach(function(row){
        var tr=document.createElement('tr');
        tr.appendChild(h('td','p',row[0]));
        tr.appendChild(h('td','n',String(row[1])));
        tb.appendChild(tr);
      });
      col.appendChild(tb);
      cols.appendChild(col);
    });
    if(cols.children.length) s5.appendChild(cols);
  }
  xr.appendChild(s5);

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
    // A fact about the record, not about the app. The builds table began on
    // 10 Aug, so every app older than it reads empty here while plainly being
    // built and running -- oh6sn did, an hour after this shipped. "Never been
    // built" would be the same lie that the since fields and BuildsWindow exist
    // to stop, told one field further along.
    s4.appendChild(h('div','none','No builds recorded for this app.'));
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
      // No elapsed time here: for a build that has not ended, "how long has it
      // run" and the row's own "when did it start" are the same number, and it
      // was printed twice until someone looked at it. The left column is what
      // makes a stuck build look stuck -- "9d ago  platform  in flight".
      else if(b.endedAt===null){ out='in flight'; cls='n'; }
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
