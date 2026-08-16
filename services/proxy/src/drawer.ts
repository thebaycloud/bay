import { XRAY_CSS, XRAY_JS } from "./xray-panel";

/**
 * The drawer: everything an owner can do to their app, inside the app.
 *
 * WHAT THIS REPLACES
 *
 * The X-ray was a small card floating in the corner, and it could only ever
 * show — who is here, what is slow, what broke, who visited, what shipped. Every
 * verb lived somewhere else: to look at your database, your files, your
 * scheduled jobs or your secrets you left the app and went to a page ABOUT the
 * app on another hostname. That is the split this removes. The app is the
 * dashboard, so the dashboard has to be able to do things.
 *
 * The X-ray is now one section of this rather than a surface of its own, which
 * is why `xray-panel.ts` is imported rather than reimplemented. Its drawXray
 * renders into whatever element the variable `xr` points at, so the drawer
 * simply points it at a section body. Two copies of that rendering would drift
 * within a week and the one that drifted would be the one nobody was looking at.
 *
 * NATIVE, NOT AN IFRAME
 *
 * Every panel here is drawn by this file against the control plane's existing
 * JSON APIs. An iframe of the dashboard would have been a day's work instead of
 * this, and it would have shipped a second scrollbar, a second font stack, a
 * second loading spinner and a visible seam down the middle of the owner's own
 * app. It also could not live in the shadow root, which is the thing that keeps
 * a tenant's CSS from reaching in and ours from leaking out.
 *
 * OWNER ONLY, AS SOURCE
 *
 * This whole file is emitted only inside the `owner ? OWNER_JS : ""` branch in
 * inject.ts. A visitor is not served it and cannot read it out of the page —
 * the same rule the toolbar already keeps, and the reason the analytics tracker
 * is deliberately OUTSIDE that branch while all of this is inside it.
 */

export const DRAWER_CSS = String.raw`
.dw{position:fixed;top:0;right:0;height:100vh;width:min(460px,100vw);z-index:2147483001;
    background:#15140f;color:#eae8df;border-left:1px solid #2a2925;
    box-shadow:-24px 0 60px rgba(0,0,0,.45);display:flex;flex-direction:column;
    transform:translateX(100%);transition:transform .22s cubic-bezier(.4,0,.2,1)}
.dw.on{transform:translateX(0)}
/* On its own page the drawer IS the page: no sliding over anything, no shadow
   against an empty backdrop, and it scrolls with the document. */
.dw.flat{position:static;height:auto;width:100%;box-shadow:none;border-left:0;transform:none;background:transparent}
.dw-scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.35);
          opacity:0;transition:opacity .22s;pointer-events:none}
.dw-scrim.on{opacity:1;pointer-events:auto}
.dw-head{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;border-bottom:1px solid #2a2925;flex:none}
.dw-head .t{font:600 13px/1.2 sans-serif;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dw-head .t a{color:#eae8df;text-decoration:none}
.dw-head .t a:hover{color:#2ea86a}
.dw-x{background:none;border:0;color:#7a786f;cursor:pointer;font:400 18px/1 sans-serif;padding:0 2px}
.dw-x:hover{color:#eae8df}
.dw-nav{display:flex;gap:2px;padding:8px 10px;border-bottom:1px solid #2a2925;flex:none;overflow-x:auto}
.dw-nav button{background:none;border:0;cursor:pointer;color:#9c9a8f;white-space:nowrap;
               font:600 11.5px/1 sans-serif;padding:7px 10px;border-radius:7px}
.dw-nav button:hover{color:#eae8df;background:#1f1e1a}
.dw-nav button.on{background:#20301f;color:#2ea86a}
.dw-body{flex:1;overflow:auto;padding:14px 16px 28px}
.dw h5.danger{color:#d1615d;margin-top:22px;padding-top:16px;border-top:1px solid #2a2925}
.dw h5{margin:0 0 8px;font:600 10.5px sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#2ea86a}
.dw .muted{font:400 12px/1.6 sans-serif;color:#9c9a8f}
.dw .warn{font:400 12px/1.5 sans-serif;color:#d1615d;margin:6px 0}
.dw .row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #232219;font:400 12px sans-serif}
.dw .row:last-child{border-bottom:0}
.dw .row .g{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dw .row .s{color:#7a786f;font:400 11px ui-monospace,Menlo,monospace;flex:none}
.dw .mono{font-family:ui-monospace,Menlo,monospace}
.dw input{background:#0f0f0c;border:1px solid #35342e;color:#eae8df;border-radius:6px;
          padding:6px 8px;font:400 12px ui-monospace,Menlo,monospace;outline:none;min-width:0;flex:1}
.dw input:focus{border-color:#2ea86a}
.dw .b{background:#2b2a26;color:#eae8df;border:0;border-radius:6px;padding:6px 10px;
       font:600 11.5px sans-serif;cursor:pointer;flex:none}
.dw .b:hover{background:#39382f}
.dw .b.go{background:#2ea86a;color:#05130b}
.dw .b.bad{background:#3a1f1e;color:#e8938f}
.dw .b.bad:hover{background:#512928}
.dw .form{display:flex;gap:6px;margin:8px 0}
.dw .tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}
.dw .tabs button{background:#1f1e1a;border:0;color:#9c9a8f;cursor:pointer;border-radius:6px;
                 padding:5px 8px;font:400 11px ui-monospace,Menlo,monospace}
.dw .tabs button.on{background:#20301f;color:#2ea86a}
.dw .grid{overflow:auto;border:1px solid #2a2925;border-radius:8px;max-height:46vh}
.dw table.dg{border-collapse:collapse;font:400 11px ui-monospace,Menlo,monospace;width:100%}
.dw .dg th{position:sticky;top:0;background:#1c1b18;color:#9c9a8f;text-align:left;padding:6px 8px;
           border-bottom:1px solid #2a2925;font-weight:600;white-space:nowrap}
.dw .dg td{padding:5px 8px;border-bottom:1px solid #232219;color:#eae8df;white-space:nowrap;
           max-width:220px;overflow:hidden;text-overflow:ellipsis}
/* The X-ray, drawn by xray-panel.ts, loses the framing it needs as a floating
   card: in here the drawer is the frame. */
.dw .xr{position:static;width:100%;max-height:none;border:0;border-radius:0;box-shadow:none;background:transparent}
.dw .xr h4{padding:0 0 10px}
.dw .xr sec{padding:10px 0}
${XRAY_CSS}
`;

export const DRAWER_JS = String.raw`
${XRAY_JS}
// ---- the drawer ----
//
// Built against three things the host supplies: h(tag, class, text), C, and a
// root to append into. Same contract the toolbar and the X-ray already use.
var dw=null,dwScrim=null,dwBody=null,dwTab='xray',dwFlat=false;

function api(path,opts){
  // credentials:'include' because this is a DIFFERENT ORIGIN — the drawer runs
  // on the app's own hostname and the control plane answers on app.*. The route
  // allows exactly this app's origin and no other subdomain; see lib/cors.ts for
  // the cross-tenant attack that a wider allowlist would open.
  return fetch(C.app+'/api/apps/'+C.slug+path,Object.assign({credentials:'include'},opts||{}))
    .then(function(r){return r.json()})
    .catch(function(e){return {error:String(e)}});
}
function jpost(path,body){
  return api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
function loading(){ var d=h('div','muted','Reading...'); dwBody.appendChild(d); return d; }
function fail(msg){ dwBody.appendChild(h('div','warn','⚠ '+String(msg).slice(0,160))); }
function fmtSize(n){ if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
function cell(v){ if(v===null||v===undefined)return '—'; if(typeof v==='object')return JSON.stringify(v); return String(v); }

// ---- sections ----

function drawXraySection(){
  // The X-ray is not reimplemented here. drawXray renders into whatever xr
  // points at, so point it at this section and let the existing poll drive it.
  var box=h('div','xr'); dwBody.appendChild(box);
  xr=box;
  drawXray({since:{live:Date.now()},live:{here:{count:0,names:[]},paths:[],dropped:0}});
  pullXray();
  if(!xrTimer) xrTimer=setInterval(pullXray,3000);
}

function drawData(){
  var head=h('h5',null,'Database'); dwBody.appendChild(head);
  var tabs=h('div','tabs'); dwBody.appendChild(tabs);
  var qform=h('div','form');
  var q=document.createElement('input'); q.placeholder='SELECT * FROM … (read-only)';
  var run=h('button','b go','Run');
  qform.appendChild(q); qform.appendChild(run); dwBody.appendChild(qform);
  var out=h('div'); dwBody.appendChild(out);

  function grid(d){
    out.innerHTML='';
    if(d.error){ out.appendChild(h('div','warn','⚠ '+String(d.error).slice(0,160))); return; }
    if(!d.rows||!d.rows.length){ out.appendChild(h('div','muted','0 rows')); return; }
    var wrap=h('div','grid'); var t=document.createElement('table'); t.className='dg';
    var thead=document.createElement('thead'); var htr=document.createElement('tr');
    d.columns.forEach(function(c){ var th=document.createElement('th'); th.textContent=c; htr.appendChild(th); });
    thead.appendChild(htr); t.appendChild(thead);
    var tb=document.createElement('tbody');
    d.rows.slice(0,200).forEach(function(r){
      var tr=document.createElement('tr');
      d.columns.forEach(function(c){ var td=document.createElement('td'); td.textContent=cell(r[c]); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); out.appendChild(wrap);
    if(d.rows.length>200) out.appendChild(h('div','muted',d.rows.length+' rows, first 200 shown'));
  }
  function open(name,btn){
    Array.prototype.forEach.call(tabs.children,function(b){ b.className=''; });
    if(btn) btn.className='on';
    out.innerHTML=''; out.appendChild(h('div','muted','Reading...'));
    api('/db?table='+encodeURIComponent(name)).then(grid);
  }
  run.onclick=function(){ if(!q.value.trim())return; out.innerHTML=''; out.appendChild(h('div','muted','Running...')); jpost('/db',{sql:q.value}).then(grid); };
  q.onkeydown=function(e){ if(e.key==='Enter') run.onclick(); };

  var l=loading();
  api('/db').then(function(d){
    l.remove();
    if(d.error){ fail(d.error); return; }
    if(!d.tables||!d.tables.length){ dwBody.appendChild(h('div','muted','No tables yet.')); return; }
    head.textContent='Database · '+(d.database||'');
    d.tables.forEach(function(t,i){
      var b=h('button',null,t.name+' ('+t.rows+')');
      b.onclick=function(){ open(t.name,b); };
      tabs.appendChild(b);
      if(i===0) open(t.name,b);
    });
  });
}

function drawFiles(){
  dwBody.appendChild(h('h5',null,'Files'));
  var l=loading();
  api('/storage').then(function(d){
    l.remove();
    if(d.error) fail(d.error);
    if(d.bucket) dwBody.appendChild(h('div','muted',d.bucket));
    var objs=d.objects||[];
    if(!objs.length){ dwBody.appendChild(h('div','muted','No files yet. Your app reads and writes this bucket through the STORAGE_BUCKET variable.')); return; }
    objs.forEach(function(o){
      var r=h('div','row');
      r.appendChild(h('span','g mono',o.name));
      r.appendChild(h('span','s',fmtSize(o.size)));
      dwBody.appendChild(r);
    });
  });
}

function drawJobs(){
  dwBody.appendChild(h('h5',null,'Jobs'));
  var form=h('div','form');
  var nm=document.createElement('input'); nm.placeholder='name';
  var sc=document.createElement('input'); sc.placeholder='0 9 * * *';
  var pa=document.createElement('input'); pa.placeholder='/cron';
  var add=h('button','b go','Add');
  form.appendChild(nm); form.appendChild(sc); form.appendChild(pa); form.appendChild(add);
  dwBody.appendChild(form);
  var list=h('div'); dwBody.appendChild(list);

  function load(){
    list.innerHTML=''; list.appendChild(h('div','muted','Reading...'));
    api('/jobs').then(function(d){
      list.innerHTML='';
      if(d.error) list.appendChild(h('div','warn','⚠ '+String(d.error).slice(0,160)));
      var jobs=d.jobs||[];
      if(!jobs.length){ list.appendChild(h('div','muted','Nothing is scheduled. A job POSTs to a path in your app on a cron.')); return; }
      jobs.forEach(function(j){
        var r=h('div','row');
        r.appendChild(h('span','g',j.label));
        r.appendChild(h('span','s',j.schedule));
        var go=h('button','b','Run'); go.onclick=function(){ go.textContent='...'; jpost('/jobs',{run:j.id}).then(function(){ go.textContent='Ran'; }); };
        var rm=h('button','b bad','Remove'); rm.onclick=function(){ api('/jobs?id='+encodeURIComponent(j.id),{method:'DELETE'}).then(load); };
        r.appendChild(go); r.appendChild(rm);
        list.appendChild(r);
      });
    });
  }
  add.onclick=function(){
    if(!sc.value.trim())return;
    add.textContent='...';
    jpost('/jobs',{name:nm.value||'job',schedule:sc.value,path:pa.value||'/cron'}).then(function(d){
      add.textContent='Add';
      if(d.error){ fail(d.error); return; }
      nm.value=''; load();
    });
  };
  load();
}

function drawSecrets(){
  dwBody.appendChild(h('h5',null,'Secrets'));
  // Keys only, values never. The API returns no values and this asks for none —
  // the point of a secret is that the platform is the only thing that has read
  // it, and a panel that could show one would make that untrue.
  dwBody.appendChild(h('div','muted','The only thing that cannot be written in your code. Values are never shown, here or anywhere.'));
  var form=h('div','form');
  var k=document.createElement('input'); k.placeholder='NAME';
  var v=document.createElement('input'); v.placeholder='value'; v.type='password';
  var save=h('button','b go','Save');
  form.appendChild(k); form.appendChild(v); form.appendChild(save);
  dwBody.appendChild(form);
  var list=h('div'); dwBody.appendChild(list);

  function paint(keys){
    list.innerHTML='';
    if(!keys||!keys.length){ list.appendChild(h('div','muted','None set.')); return; }
    keys.forEach(function(key){
      var r=h('div','row');
      r.appendChild(h('span','g mono',key));
      var rm=h('button','b bad','Remove');
      rm.onclick=function(){ rm.textContent='...'; jpost('/env',{unset:[key]}).then(function(d){ if(d.error){fail(d.error);rm.textContent='Remove';return;} paint(d.keys); }); };
      r.appendChild(rm); list.appendChild(r);
    });
  }
  save.onclick=function(){
    if(!k.value.trim()||!v.value)return;
    save.textContent='...';
    var body={set:{}}; body.set[k.value.trim()]=v.value;
    jpost('/env',body).then(function(d){
      save.textContent='Save';
      if(d.error){ fail(d.error); return; }
      k.value=''; v.value=''; paint(d.keys);
      // Saying so matters: a secret is applied by rolling a new version, so the
      // app the owner is looking at is not yet the app that has it.
      list.appendChild(h('div','muted','Saved. A new version is rolling out with it.'));
    });
  };
  var l=loading();
  api('/env').then(function(d){ l.remove(); if(d.error) fail(d.error); paint(d.keys); });
}

function drawAddress(){
  dwBody.appendChild(h('h5',null,'Address'));
  var r=h('div','row');
  var a=document.createElement('a'); a.href='https://'+C.slug+'.supersonic.cv'; a.target='_blank';
  a.className='g mono'; a.style.color='#eae8df'; a.style.textDecoration='none';
  a.textContent=C.slug+'.supersonic.cv';
  r.appendChild(a); r.appendChild(h('span','s','HTTPS is on'));
  dwBody.appendChild(r);
  dwBody.appendChild(h('div','muted','Your own domain is not connected yet — that is still being built.'));
}

function drawShare(){
  dwBody.appendChild(h('h5',null,'Who can open this'));
  var list=h('div'); dwBody.appendChild(list);
  var OPTS=[['private','Only me'],['shared','Specific people'],['public','Anyone with the link']];
  function paint(j){
    vis=j.visibility||vis; grants=j.grants||[]; reqs=j.requests||[];
    list.innerHTML='';
    OPTS.forEach(function(o){
      var r=h('div','row');
      r.appendChild(h('span','g',o[1]));
      var b=h('button','b'+(vis===o[0]?' go':''),vis===o[0]?'On':'Choose');
      b.onclick=function(){ b.textContent='...'; api('/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visibility:o[0]})}).then(paint); };
      r.appendChild(b); list.appendChild(r);
    });
    if(vis==='shared'){
      var f=h('div','form');
      var em=document.createElement('input'); em.type='email'; em.placeholder='colleague@company.com';
      var inv=h('button','b go','Invite');
      inv.onclick=function(){ if(!em.value)return; inv.textContent='...'; api('/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({addEmail:em.value})}).then(function(j){ inv.textContent='Invite'; em.value=''; paint(j); }); };
      f.appendChild(em); f.appendChild(inv); list.appendChild(f);
      grants.forEach(function(g){
        var r=h('div','row'); r.appendChild(h('span','g',g));
        var rm=h('button','b bad','Remove');
        rm.onclick=function(){ api('/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({removeEmail:g})}).then(paint); };
        r.appendChild(rm); list.appendChild(r);
      });
    }
    reqs.forEach(function(e){
      var r=h('div','row'); r.appendChild(h('span','g',e+' asked for access'));
      var ok=h('button','b go','Approve');
      ok.onclick=function(){ api('/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({addEmail:e})}).then(paint); };
      r.appendChild(ok); list.appendChild(r);
    });
  }
  var l=loading();
  api('/share').then(function(j){ l.remove(); if(j.error){fail(j.error);return;} paint(j); });

  // Deleting lives at the bottom of the last section rather than in a tab of its
  // own: it is not a setting, it is an ending, and it should be somewhere you
  // arrive at deliberately.
  dwBody.appendChild(h('h5','danger','Delete this app'));
  dwBody.appendChild(h('div','muted','Its address, its database and its files go too. This cannot be undone.'));
  var df=h('div','form');
  var typed=document.createElement('input'); typed.placeholder='type '+C.slug+' to confirm';
  var del=h('button','b bad','Delete');
  del.onclick=function(){
    if(typed.value!==C.slug){ fail('Type the app\'s name to confirm.'); return; }
    del.textContent='...';
    api('/delete',{method:'POST'}).then(function(d){
      if(d.error){ fail(d.error); del.textContent='Delete'; return; }
      dwBody.innerHTML=''; dwBody.appendChild(h('div','muted',C.slug+' is gone.'));
    });
  };
  df.appendChild(typed); df.appendChild(del); dwBody.appendChild(df);
}

var DW_TABS=[
  ['xray','X-ray',drawXraySection],
  ['data','Data',drawData],
  ['files','Files',drawFiles],
  ['jobs','Jobs',drawJobs],
  ['secrets','Secrets',drawSecrets],
  ['address','Address',drawAddress],
  ['share','Share',drawShare]
];

function dwSelect(id){
  dwTab=id;
  Array.prototype.forEach.call(dw.querySelectorAll('.dw-nav button'),function(b){
    b.className = b.getAttribute('data-id')===id ? 'on' : '';
  });
  // The X-ray poll is stopped whenever its section is not on screen. Left
  // running it would keep asking /_xray every three seconds while the owner
  // reads their database, for a panel nothing is drawing.
  if(id!=='xray' && xrTimer){ clearInterval(xrTimer); xrTimer=null; xr=null; }
  dwBody.innerHTML='';
  for(var i=0;i<DW_TABS.length;i++) if(DW_TABS[i][0]===id){ DW_TABS[i][2](); return; }
}

function buildDrawer(flat){
  dwFlat=!!flat;
  dw=h('aside','dw'+(flat?' flat':''));
  // No header in flat mode: the page it sits on already names the app directly
  // above, and a drawer that repeats it reads as two panels stacked.
  if(!flat){
    var head=h('div','dw-head');
    var t=h('div','t');
    var link=document.createElement('a'); link.href='https://'+C.slug+'.supersonic.cv'; link.textContent=C.slug+'.supersonic.cv';
    t.appendChild(link); head.appendChild(t);
    var x=h('button','dw-x','×'); x.onclick=closeDrawer; head.appendChild(x);
    dw.appendChild(head);
  }
  var nav=h('div','dw-nav');
  DW_TABS.forEach(function(tab){
    var b=h('button',null,tab[1]); b.setAttribute('data-id',tab[0]);
    b.onclick=function(){ dwSelect(tab[0]); };
    nav.appendChild(b);
  });
  dw.appendChild(nav);
  dwBody=h('div','dw-body'); dw.appendChild(dwBody);
  return dw;
}

function openDrawer(){
  if(dw){ closeDrawer(); return; }
  if(pop){ pop.remove(); pop=null; }
  dwScrim=h('div','dw-scrim'); dwScrim.onclick=closeDrawer; root.appendChild(dwScrim);
  root.appendChild(buildDrawer(false));
  dwSelect(dwTab);
  // One frame before adding .on, or the browser has nothing to animate from.
  requestAnimationFrame(function(){ dw.className='dw on'; dwScrim.className='dw-scrim on'; });
}
function closeDrawer(){
  if(!dw)return;
  if(xrTimer){ clearInterval(xrTimer); xrTimer=null; xr=null; }
  var d=dw,s=dwScrim; dw=null; dwScrim=null; dwBody=null;
  d.className='dw'; if(s) s.className='dw-scrim';
  setTimeout(function(){ d.remove(); if(s) s.remove(); },240);
}
`;
