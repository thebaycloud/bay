/**
 * How long ago, in the shortest true form.
 *
 * Lifted out of xray-panel.ts when that module was deleted. The panel used two
 * functions from twelve kilobytes of dark-themed code it otherwise shipped to
 * every owner on every page load and never rendered a pixel of; these are the
 * two. ago() is defined through dur() rather than beside it so the two cannot
 * disagree about where an hour ends.
 */
function dur(sec){ if(sec<60)return sec+'s'; if(sec<3600)return Math.round(sec/60)+'m'; if(sec<86400)return Math.round(sec/3600)+'h'; return Math.round(sec/86400)+'d'; }
function ago(sec){ return dur(sec)+' ago'; }

/* ---- the whole umami reading, fetched when the screen asks for it ---- */

var DW_RANGES=[['1d','Today'],['7d','7 days'],['30d','30 days'],['1y','Year']];
var dwRange='1d', dwDetail=null, dwDetailFor=null, dwDetailOn=true, dwDetailReq=null;

/**
 * Every dimension umami will answer for, over one window.
 *
 * Owner-only and same-origin, so no CORS and no bearer: /_dashboard/analytics is
 * answered by the proxy in front of this very app. Deliberately NOT part of
 * dwLoad — that fires on every panel open and this is twenty-odd admin queries
 * against an instance sized for a 2KB tracker. It happens when somebody opens
 * Analytics, once per window, and nothing polls it.
 */
function dwStats(range, force){
  if(!force && dwDetailFor===range && dwDetail!==null) return Promise.resolve(dwDetail);
  if(dwDetailReq && !force) return dwDetailReq;
  dwDetailReq = dwSoon(
    fetch('/_dashboard/analytics?range='+encodeURIComponent(range),
          {credentials:'include',headers:{Accept:'application/json'}})
      .then(function(r){ return r.json(); }),
    // Longer than the server's own 12s budget for this read. Giving up first
    // would show 'that did not come back' about an answer already on its way.
    20000, null
  ).then(function(j){
    dwDetailReq=null; dwDetailFor=range;
    dwDetail = j ? j.detail : null;
    dwDetailOn = j ? !!j.on : false;
    return dwDetail;
  });
  return dwDetailReq;
}

/**
 * The window's shape, as columns.
 *
 * The only chart in the panel, and it earns it: a series is the one reading here
 * that means nothing as a list. Deliberately unlabelled on the x — the window
 * says what the span is, and axis ticks at this size are chrome.
 */
function spark(series){
  var w=el('div','spark');
  var max=series.reduce(function(m,p){ return Math.max(m,p.views); },1);
  series.forEach(function(p){
    var col=el('div','col');
    var fill=el('div','f');
    fill.style.height=Math.max(2, Math.round((p.views/max)*100))+'%';
    col.appendChild(fill);
    col.title=p.t+' - '+p.views+(p.views===1?' view':' views')+', '+p.sessions+(p.sessions===1?' visit':' visits');
    w.appendChild(col);
  });
  return w;
}

/**
 * The most recent moment any of this owner's tokens was used.
 *
 * Null when they have none, and null when they have some that have never been
 * used — two states the screen says differently, because "no token" is something
 * to fix and "never used" is something to try.
 */
function dwLastAgent(d){
  var best=null;
  (d.tokens||[]).forEach(function(t){
    if(!t.last_used_at) return;
    var ms=Date.parse(t.last_used_at);
    if(isFinite(ms) && (best===null || ms>best)) best=ms;
  });
  return best;
}

/** A mean session length, said the way a person would say it. */
function dwMins(sec){
  sec=Math.round(Number(sec)||0);
  if(sec<60) return sec+'s';
  var m=Math.floor(sec/60), r=sec%60;
  return r ? m+'m '+r+'s' : m+'m';
}

/** Why a block is showing dashes. One sentence, and it never guesses a number. */
function dwWhyNoNumbers(d){
  if(d.anWindow==='off' || !d.anOn) return 'Analytics is off, so nobody is being counted.';
  if(!d.anReady) return 'Analytics is still being set up for this app.';
  if(d.anWindow==='unreadable') return 'The analytics service could not be reached just now.';
  return 'Nobody has opened it in the last day.';
}

/**
 * Geist, registered on the document rather than in here.
 *
 * A shadow root cannot carry an @font-face: font faces are resolved against the
 * document, and one declared inside a shadow tree is simply ignored. So the
 * face is added to document.fonts and nothing else is - no rule, no class, no
 * stylesheet on the tenant's page. That keeps the one-way promise the shadow
 * root exists for: our styles still cannot reach their app.
 *
 * Cross-origin, and fonts are always fetched in CORS mode, so this depends on
 * the Access-Control-Allow-Origin header on /fonts/* (see apps/web/next.config.mjs).
 * If any of it fails the tokens already name system-ui next, so the panel is
 * merely less pretty, never unstyled.
 */
(function(){
  if(!window.FontFace||!document.fonts) return;
  [['Geist','/fonts/Geist-Variable.woff2'],['Geist Mono','/fonts/GeistMono-Variable.woff2']]
  .forEach(function(f){
    try{
      if(document.fonts.check('12px "'+f[0]+'"')) return;
      var face=new FontFace(f[0],'url("'+C.app+f[1]+'") format("woff2")',
                            {weight:'100 900',display:'swap'});
      face.load().then(function(loaded){ document.fonts.add(loaded); })
                 .catch(function(e){ console.error('panel font:',e); });
    }catch(e){ console.error('panel font:',e); }
  });
})();

// ---- the panel: state ----
//
// 'dwOpen' rather than 'open', 'dwPop' rather than 'pop', 'dwApi' rather than
// 'api': this file is interpolated into OWNER_JS *after* the toolbar, and a
// second 'function api(...)' in that scope silently rebinds the toolbar's own.
// (It did, until this rewrite — Share was posting to '/api/apps/<slug>[object
// Object]' and swallowing the 404.) Names here are prefixed for that reason.
var dw=null,dwScrim=null,dwScroll=null,dwHeadEl=null,dwGrip=null,dwFlat=false;
var dwOpen=false,dwStack=[],dwDir='push',dwFeedTimer=null;
var dwD=null,dwPending=null,dwErr=null;

/**
 * A request that cannot hang the panel.
 *
 * Everything here is fetched at once so home can show a fact per cell, and the
 * first version waited on Promise.all with no deadline anywhere. One of the
 * eight is /_xray, which assembles its reading from Umami - a service
 * reading.ts itself says can be off or unreachable - so one slow answer left
 * the whole panel reading "Reading..." forever, with nothing on screen and
 * nothing in the console. A cell holding a dash is worth more than seven cells
 * that never arrive.
 */
function dwSoon(p,ms,fallback){
  return new Promise(function(resolve){
    var done=false;
    var t=setTimeout(function(){ if(!done){ done=true; resolve(fallback); } },ms||6000);
    p.then(function(v){ if(!done){ done=true; clearTimeout(t); resolve(v); } },
           function(){ if(!done){ done=true; clearTimeout(t); resolve(fallback); } });
  });
}

function dwApi(path,opts){
  // credentials:'include' because this is a DIFFERENT ORIGIN — the panel runs
  // on the app's own hostname and the control plane answers on app.*. The route
  // allows exactly this app's origin and no other subdomain; see lib/cors.ts for
  // the cross-tenant attack that a wider allowlist would open.
  return fetch(C.app+'/api/apps/'+C.slug+path,Object.assign({credentials:'include'},opts||{}))
    .then(function(r){return r.json()})
    .catch(function(e){return {error:String(e)}});
}
function dwPost(path,body){
  return dwApi(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
function dwLive(){
  // The live half is the app's own origin, not the control plane: /_xray is
  // served by the proxy in front of this very app, so it is same-origin and
  // needs no CORS at all.
  return fetch('/_xray',{credentials:'include',headers:{Accept:'application/json'}})
    .then(function(r){return r.json()}).catch(function(){return null});
}

/** Rows out of information_schema come back under names that have changed once
 *  already; read them defensively rather than pinning one spelling. */
function dwTableRow(t){
  var name=t.table_name||t.tablename||t.name||String(t);
  var n=t.n_live_tup!=null?t.n_live_tup:(t.rows!=null?t.rows:0);
  return [name,Number(n)||0];
}
function dwKeyName(k){ return typeof k==='string'?k:(k.key||k.name||String(k)); }

/**
 * Everything the panel shows, fetched at once.
 *
 * Seven requests in parallel and not seven screens each fetching on arrival:
 * home shows a live fact on every cell — how many tables, how many keys, who is
 * here — so a panel that fetched per-screen would open onto six spinners and
 * then still be wrong, because the facts it summarises live behind six
 * different routes. Kicked off before the panel is opened (see the idle call at
 * the end of this file), so the common case is that it is already here.
 */
function dwLoad(force){
  if(dwPending && !force) return dwPending;
  if(dwD && !force) return Promise.resolve(dwD);
  dwPending=Promise.all([
    dwSoon(dwApi('/share'),6000,{}),   dwSoon(dwApi('/env'),6000,{}),
    dwSoon(dwApi('/db'),6000,{}),      dwSoon(dwApi('/storage'),6000,{}),
    dwSoon(dwApi('/jobs'),6000,{}),    dwSoon(dwApi('/deploy-status'),6000,{}),
    dwSoon(dwApi('/analytics'),6000,{}), dwSoon(dwApi('/agent'),6000,{}),
    // Shorter, and first to be given up on: this is the one that reaches Umami.
    dwSoon(dwLive(),4000,null)
  ]).then(function(r){
    var share=r[0]||{},env=r[1]||{},db=r[2]||{},store=r[3]||{},jobs=r[4]||{},
        dep=r[5]||{},an=r[6]||{},agent=r[7]||{},live=r[8];
    var grants=share.grants||[];
    var here=[],feed=[];
    if(live&&live.live){
      var L=live.live;
      (L.here.names||[]).forEach(function(n){ here.push([n,'here now']); });
      var anon=(L.here.count||0)-(L.here.names||[]).length;
      if(anon>0) here.push([anon+(anon===1?' person':' people')+' not signed in','']);
      // One source, honestly. The prototype interleaved edge/web/api/db/redis;
      // the edge is the only one of those the proxy actually hears, so the rest
      // are not drawn rather than drawn empty.
      feed=(L.paths||[]).slice(0,40).map(function(p){
        var tone=p.brokenFor?'bad':'';
        return ['edge',p.path,(p.hits+' · '+p.p50+'ms · '+ago(p.ago)),tone];
      });
    }
    var aud = live && live.audience ? live.audience : null;
    var broken=(live&&live.live?(live.live.paths||[]):[]).filter(function(p){return p.brokenFor});
    var d={
      slug:C.slug,
      addr:C.slug+'.supersonic.cv',
      // The people half. /analytics answers whether analytics is ON; the
      // COUNTING is already read from umami by the proxy and carried in the
      // reading, so this needs no endpoint of its own and no second round trip
      // — it arrives on the same fetch as the live half.
      //
      // Never added to or compared with the live numbers beside it: the edge
      // counts requests and umami counts people, and one page view with eleven
      // assets on it is eleven requests and one visitor. analytics.ts keeps that
      // line at the source and this keeps it here.
      an: aud ? {
        visitors: aud.visitors, views: aud.views,
        mins: dwMins(aud.avgSeconds),
        // Umami gives a bounce rate, not a returning count. The tile says what
        // the number is rather than what the prototype wished it were.
        returning: (Math.round(Number(aud.bounce)||0))+'%',
        dv: aud.change==null ? '' : (aud.change>0?'+':'')+Math.round(aud.change)+'%',
        dvUp: (Number(aud.change)||0) >= 0,
        pages: aud.pages||[], from: aud.from||[], on: aud.on||[]
      } : null,
      anWindow: (live&&live.since) ? live.since.audience : 'off',
      anOn:an.enabled!==false, anReady:Boolean(an.provisioned),
      here:here, initials:here.map(function(x){return ini(x[0])}),
      feed:feed,
      who:share.visibility||'private',
      people:grants, pInitials:grants.map(ini),
      requests:share.requests||[],
      tables:(db.tables||[]).map(dwTableRow),
      files:(store.objects||[]).length,
      missing:db.error||null,
      keys:(env.keys||[]).map(function(k){ return {name:dwKeyName(k),tone:'',st:'set'}; }),
      jobs:jobs.jobs||[],
      // Tokens belong to a person, not to an app: one deploys everything they
      // own. So this is the last time a token was used AT ALL, and the screen
      // says it in those words rather than claiming a per-app fact we do not
      // record.
      tokens:(agent.tokens||[]),
      mcp:Boolean(agent.mcp),
      // deploys.ts: status is live | building | deploying | pending | failed |
      // canceled, and there is no 'done'. Reading stage for doneness would have
      // left every finished app saying "Shipping" forever, because stage holds
      // the last step it ran (deploy, verify, fleet-boot), not whether it ended.
      shipping:['building','deploying','pending'].indexOf(String(dep.deploy&&dep.deploy.status))>=0,
      ships:[],dock:null,
      alert:null
    };
    if(dep.deploy){
      var dd=dep.deploy, st=String(dd.status||'');
      var stamp=dd.finishedAt||dd.updatedAt;
      d.ships=[{
        did:dd.name||dd.stage||'a change',
        when:stamp?ago(Math.round((Date.now()-new Date(stamp).getTime())/1000)):'just now',
        // The row records no actor. An owner is the only person who can see this
        // panel, so naming them is honest; inventing a name would not be.
        who:'you',
        out:st==='live'?'shipped':(st==='failed'||st==='canceled')?'never left':'live',
        status:st, stage:dd.stage||'', error:dd.error||null, url:dd.url||null
      }];
      if(dd.error) d.alert=d.alert||{kind:'bad',icon:'refresh-cw',
        title:'The last ship did not land',sub:String(dd.error).slice(0,160),act:'Look at it'};
    }
    if(!d.ships.length) d.ships=[{did:'first ship',when:'not yet',who:'you',out:'live'}];
    if(broken.length){
      var b=broken[0];
      d.alert={kind:'bad',icon:'refresh-cw',title:b.path+' has been failing for '+dur(b.brokenFor),
               sub:'The edge has seen no success there since.',act:'Look at it'};
    }
    dwD=d; dwErr=null; dwPending=null;
    return d;
  }).catch(function(e){
    // Never swallowed, and never left spinning: the panel says so and
    // offers the retry, which is the only useful thing left to do.
    console.error('panel:',e);
    dwErr=String(e&&e.message||e); dwPending=null; dwD=null;
    return null;
  });
  return dwPending;
}

function dwHeading(){
  var v=dwTop(); if(!v) return null;
  return headingFor(v,dwD);
}

/** Paint the whole panel from 'dwD'. Cheap enough to do on every navigation. */
function dwRender(){
  if(!dw) return;
  clearInterval(dwFeedTimer);
  if(!dwD){
    dwScroll.innerHTML='';
    if(dwErr){
      // Never left spinning. A panel that says "Reading..." forever is
      // indistinguishable from one that is broken, which is what this was.
      var ep=pad('That did not come back','Nothing could be read about this app just now.');
      var again=btn('Try again','refresh-cw',{rest:'white',hover:'steel',size:'sm'});
      again.addEventListener('click',function(){
        dwErr=null; dwRender(); dwLoad(true).then(function(){ dwRender(); });
      });
      ep.appendChild(again);
      dwScroll.appendChild(ep);
    } else {
      dwScroll.appendChild(pad('Reading…','Fetching what your app is doing.'));
    }
    return;
  }
  var d=dwD,view=dwTop();

  dwHeadEl.innerHTML='';
  var Lft=el('div','head-l');
  if(!view){
    Lft.appendChild(el('span','slug',d.slug));
  } else {
    var back=el('button','nav');
    back.appendChild(icon('chevron-left',20));
    back.appendChild(el('span',null,dwHeading()));
    back.addEventListener('click',dwPop);
    Lft.appendChild(back);
  }
  dwHeadEl.appendChild(Lft);

  var R=el('div','head-r');
  var tone=d.alert?'warn':d.shipping?'load':'ok';
  var st=el('span','state '+tone);
  st.appendChild(el('b'));
  st.appendChild(el('span',null,d.alert?'broken':d.shipping?'shipping':'afloat'));
  R.appendChild(st);
  if(!dwFlat){
    var x=el('button','icon');
    x.setAttribute('aria-label','Close');
    x.appendChild(icon('x',18));
    x.addEventListener('click',closeDrawer);
    R.appendChild(x);
  }
  dwHeadEl.appendChild(R);

  dwScroll.innerHTML='';
  dwScroll.appendChild(view ? screen(view,d) : homeScreen(d));
  dwScroll.scrollTop=0;
  dwScroll.classList.remove('push','pop');
  void dwScroll.offsetWidth;
  dwScroll.classList.add(dwDir);
}

/** The panel's shell. 'flat' is the /_xray page, where it IS the page. */
function buildDrawer(flat){
  dwFlat=!!flat;
  dw=el('aside','drawer'+(flat?' flat':''));
  if(!flat){
    dwGrip=el('div','grip');
    dw.appendChild(dwGrip);
    dwGrip.addEventListener('pointerdown',function(e){
      dwGrip.classList.add('on'); dwGrip.setPointerCapture(e.pointerId);
      var move=function(ev){
        var w=Math.min(Math.max(window.innerWidth-ev.clientX,340),Math.min(1040,window.innerWidth-200));
        dw.style.setProperty('--w',w+'px');
      };
      var up=function(){ dwGrip.classList.remove('on');
        dw.removeEventListener('pointermove',move); dw.removeEventListener('pointerup',up); };
      dw.addEventListener('pointermove',move); dw.addEventListener('pointerup',up);
    });
  }
  dwHeadEl=el('div','head'); dw.appendChild(dwHeadEl);
  dwScroll=el('div','scroll'); dw.appendChild(dwScroll);
  dwLoad().then(function(){ dwRender(); });
  dwRender();
  return dw;
}

function openDrawer(){
  if(dw){ closeDrawer(); return; }
  if(typeof pop!=='undefined' && pop){ pop.remove(); pop=null; }
  dwOpen=true; dwStack=[]; dwDir='push';
  dwScrim=el('div','dw-scrim'); dwScrim.addEventListener('click',closeDrawer);
  root.appendChild(dwScrim);
  root.appendChild(buildDrawer(false));
  requestAnimationFrame(function(){ dw.classList.add('on'); dwScrim.classList.add('on'); });
}
function closeDrawer(){
  if(!dw) return;
  clearInterval(dwFeedTimer); dwFeedTimer=null;
  var a=dw,s=dwScrim;
  dw=null; dwScrim=null; dwScroll=null; dwHeadEl=null; dwOpen=false; dwStack=[];
  a.classList.remove('on'); if(s) s.classList.remove('on');
  setTimeout(function(){ a.remove(); if(s) s.remove(); },240);
}

/** Compatibility seam for the /_xray page, which asked for a tab by name back
 *  when this had tabs. Home is the whole panel now, so anything lands there. */
function dwSelect(){ dwStack=[]; dwDir='push'; dwRender(); }

// Warm before it is wanted. requestIdleCallback so it never competes with the
// tenant app's own load; owner-only, so this costs a visitor nothing.
if(window.requestIdleCallback) requestIdleCallback(function(){ dwLoad(); });
else setTimeout(function(){ dwLoad(); },2000);
