import pathlib, re
B=pathlib.Path(__file__).resolve().parent
S=lambda n:(B/(n+'.js')).read_text()
css=(B/'panel.css').read_text()

# The base type used to be patched onto :host here, because the prototype
# carried it on `body` and a shadow root has no body. panel.css's own token
# block states it now, so there is nothing left to re-home — and one place that
# says what the type is beats two that have to agree.

screens=S('screens')

# --- the access screen actually changes access -----------------------------
old_vis="b.addEventListener('click',function(){ d.who=o[0]; dwRender(); });"
new_vis=("b.addEventListener('click',function(){\n"
         "        var was=d.who; d.who=o[0]; dwRender();\n"
         "        dwPost('/share',{visibility:o[0]}).then(function(j){\n"
         "          if(j&&j.visibility){ d.who=j.visibility; d.people=j.grants||[]; }\n"
         "          else d.who=was;\n"
         "          dwRender();\n"
         "        });\n"
         "      });")
assert old_vis in screens, 'visibility handler not found'
screens=screens.replace(old_vis,new_vis)

# --- Invite adds a real person ---------------------------------------------
old_inv="var inv=btn('Invite','plus',{rest:'white',hover:'steel',size:'sm'});"
new_inv=(old_inv+"\n"
  "    inv.addEventListener('click',function(){\n"
  "      var em=prompt('Email of the person who may open this app');\n"
  "      if(!em) return;\n"
  "      dwPost('/share',{addEmail:em}).then(function(j){\n"
  "        if(j&&j.grants){ d.people=j.grants; d.pInitials=j.grants.map(ini); d.who=j.visibility||d.who; }\n"
  "        dwRender();\n"
  "      });\n"
  "    });")
assert old_inv in screens, 'invite button not found'
screens=screens.replace(old_inv,new_inv)

# --- Delete really deletes, behind the app's own name ----------------------
old_del="dp2.appendChild(btn('Delete this app','trash-2',{rest:'white',hover:'red',size:'md'}));"
new_del=("var del=btn('Delete this app','trash-2',{rest:'white',hover:'red',size:'md'});\n"
  "    del.addEventListener('click',function(){\n"
  "      if(prompt('Type the app name to delete it. This cannot be undone.')!==d.slug) return;\n"
  "      dwPost('/delete',{}).then(function(){ location.href=C.app; });\n"
  "    });\n"
  "    dp2.appendChild(del);")
assert old_del in screens, 'delete button not found'
screens=screens.replace(old_del,new_del)

# --- a table's rows are the app's rows, not the demo's three ---------------
old_rows=re.search(r"    if\(view\.t\)\{.*?w\.appendChild\(rp\); return w;\n    \}\n", screens, re.S)
assert old_rows, 'table detail block not found'
new_rows=("    if(view.t){\n"
  "      var rp=pad(view.t,'The newest rows.');\n"
  "      var host=el('div'); rp.appendChild(host); w.appendChild(rp);\n"
  "      host.appendChild(el('div','sec-n','Reading…'));\n"
  "      dwApi('/db?table='+encodeURIComponent(view.t)).then(function(j){\n"
  "        host.innerHTML='';\n"
  "        if(j.error||!j.rows){ host.appendChild(el('div','sec-n',j.error||'Nothing to read.')); return; }\n"
  "        if(!j.rows.length){ host.appendChild(el('div','sec-n','This table is empty.')); return; }\n"
  "        host.appendChild(listOf(j.rows.slice(0,25).map(function(row){\n"
  "          var ks=j.columns||Object.keys(row);\n"
  "          return li({lead:'#',title:String(row[ks[0]]),\n"
  "                     meta:ks.slice(1,3).map(function(k){return k+': '+row[k]}).join(' · '),\n"
  "                     val:''});\n"
  "        })));\n"
  "      });\n"
  "      return w;\n"
  "    }\n")
screens=screens[:old_rows.start()]+new_rows+screens[old_rows.end():]

# --- we do not know when a table was last written; do not claim we do ------
screens=screens.replace(
  "meta:t[1] ? 'last written '+(t[0]==='notes'?'2 minutes':'yesterday')+' ago' : 'never written to',",
  "meta:t[1] ? 'has rows' : 'never written to',")

# --- a key has no detail screen yet; do not throw trying to draw one -------
old_kd = "    if(view.i != null){\n      var k=d.keys[view.i];\n      var kp=pad(null,null);"
new_kd = ("    if(view.i != null){\n"
          "      var k=d.keys[view.i];\n"
          "      // Reachable only from a stale stack: the list below makes a row tappable\n"
          "      // only when it has a detail to show, and nothing builds one yet.\n"
          "      if(!k||!k.detail){ w.appendChild(pad('Nothing more','We have no reading on this key yet.')); return w; }\n"
          "      var kp=pad(null,null);")
assert old_kd in screens, 'keys detail head not found'
screens = screens.replace(old_kd, new_kd)

# --- say why analytics is empty, and say it truthfully ---------------------
# "Nothing has been opened" is a claim about visitors. We cannot make it: the
# numbers live in Umami and nothing here reads them yet. Distinguish the three
# real cases instead - switched off, not provisioned, and simply not wired up.
old_an = ("    if(!d.an){\n"
          "      var p0=pad('Nobody yet','Your app is live. Nothing has been opened.');\n"
          "      w.appendChild(p0); return w;\n    }")
new_an = ("    if(!d.an){\n"
          "      w.appendChild(!d.anOn\n"
          "        ? pad('Analytics is off','You turned it off. Nobody is being counted.')\n"
          "        : !d.anReady\n"
          "        ? pad('Not counting yet','Analytics has not finished being set up for this app.')\n"
          "        : pad('No numbers here yet','Visits are being counted, but this panel cannot read them back yet.'));\n"
          "      if(d.here.length){\n"
          "        var hp0=pad('In it right now',null);\n"
          "        hp0.appendChild(listOf(d.here.map(function(x){\n"
          "          var signed=x[0].indexOf('@')>0;\n"
          "          return li({lead:signed?ini(x[0]):'..', round:true,\n"
          "                     title:signed?x[0].split('@')[0]:x[0],\n"
          "                     meta:signed?x[0]:'no account', val:x[1]});\n"
          "        })));\n"
          "        w.appendChild(hp0);\n"
          "      }\n"
          "      return w;\n    }")
assert old_an in screens, 'analytics empty branch not found'
screens = screens.replace(old_an, new_an)

# --- placeholders, not prose, where there is no reading yet -----------------
# Asked for explicitly: a block with no data should still look like the block,
# so the panel reads as one finished surface rather than a half-built one. The
# figures are held as em-dashes on the real stat tiles, which keeps the shape
# and never invents a number.
old_an2 = screens[screens.index("    if(!d.an){"):screens.index("    var top=pad(null,null);")]
new_an2 = """    if(!d.an){
      var ph=pad(null,null);
      var pst=el('div','stats');
      pst.appendChild(stat('\\u2014','visitors this week'));
      pst.appendChild(stat('\\u2014','pages opened'));
      pst.appendChild(stat('\\u2014','average visit'));
      pst.appendChild(stat('\\u2014','came back'));
      ph.appendChild(pst);
      w.appendChild(ph);
      var hp0=pad('In it right now', d.here.length ? null : 'Nobody this second.');
      if(d.here.length){
        hp0.appendChild(listOf(d.here.map(function(x){
          var signed=x[0].indexOf('@')>0;
          return li({lead:signed?ini(x[0]):'\\u00b7\\u00b7', round:true,
                     title:signed?x[0].split('@')[0]:x[0],
                     meta:signed?x[0]:'no account', val:x[1]});
        })));
      }
      w.appendChild(hp0);
      w.appendChild(pad('Most opened', dwWhyNoNumbers(d)));
      w.appendChild(pad('How they got here', dwWhyNoNumbers(d)));
      return w;
    }
"""
assert old_an2.startswith("    if(!d.an){"), 'analytics empty branch not found for placeholder pass'
screens = screens.replace(old_an2, new_an2)

# --- labels that match the window and the number actually being shown --------
# analytics.ts reads a 24 hour window, not a week, and umami answers with a
# bounce rate where the prototype invented a returning count. Both labels said
# the wrong thing about a real figure, which is worse than a dash.
screens = screens.replace("'visitors this week'", "'visitors today'")
screens = screens.replace("'came back'", "'bounced'")
screens = screens.replace("stat(d.an.mins,'average visit')", "stat(d.an.mins,'average visit')")

# --- Analytics is every dimension umami has, not four numbers ---------------
# The screen used to render the six figures carried in the reading. Umami answers
# for seventeen ranked dimensions, a time series and who is on the site this
# second, and none of the rest was ever asked for. This asks, on demand, for the
# window the reader picked.
an_start = screens.index("  if(key==='analytics'){")
an_end   = screens.index("  // ----------------------------------------------------------------- ships")
screens = screens[:an_start] + """  if(key==='analytics'){
    // Which window. It is the first control because every number under it is a
    // number ABOUT a window, and the old screen quietly meant "today" while
    // saying "this week".
    var rp0=pad('Analytics', null);
    var seg=el('div','seg');
    DW_RANGES.forEach(function(r){
      var b=el('button',null,r[1]);
      b.setAttribute('aria-pressed', dwRange===r[0] ? 'true':'false');
      b.addEventListener('click',function(){
        if(dwRange===r[0]) return;
        dwRange=r[0]; dwDetail=null; dwDetailFor=null; dwRender();
        dwStats(dwRange).then(function(){ dwRender(); });
      });
      seg.appendChild(b);
    });
    rp0.appendChild(seg);
    w.appendChild(rp0);

    var det=(dwDetailFor===dwRange) ? dwDetail : null;
    if(!det){
      // Asked for once, here, rather than on every panel open.
      dwStats(dwRange).then(function(){ dwRender(); });
      w.appendChild(pad(dwDetailFor===dwRange && !dwDetailOn ? 'Analytics is off'
                        : dwDetailFor===dwRange ? 'That did not come back'
                        : 'Reading\u2026',
                        dwDetailFor===dwRange && !dwDetailOn
                          ? 'Nobody is being counted for this app.'
                          : dwDetailFor===dwRange
                          ? 'The analytics service could not be reached just now.'
                          : 'Asking for every reading over this window.'));
      return w;
    }

    var top=pad(null,null);
    var st=el('div','stats');
    st.appendChild(stat(det.visitors.toLocaleString(),'visitors',
                        det.change==null?'':(det.change>0?'+':'')+det.change+'%',
                        (det.change||0)>=0));
    st.appendChild(stat(det.views.toLocaleString(),'pages opened'));
    st.appendChild(stat(dwMins(det.avgSeconds),'average visit'));
    st.appendChild(stat(det.bounce+'%','bounced'));
    top.appendChild(st);
    w.appendChild(top);

    if(det.active){
      w.appendChild(pad('On it right now',
        det.active+(det.active===1?' person, this second':' people, this second')));
    }

    if(det.series && det.series.length){
      var sp0=pad('Over the window','Each column is one '+det.unit+'.');
      sp0.appendChild(spark(det.series));
      w.appendChild(sp0);
    }

    // Every dimension, in the order a person asks them, and only the ones this
    // umami actually answered for. An empty list is not drawn: seventeen headings
    // over seventeen blanks is a worse screen than the four numbers were.
    DW_DIMS.forEach(function(dim){
      var rows=det.dims[dim[0]];
      if(!rows || !rows.length) return;
      var q=pad(dim[1], null);
      q.appendChild(bars(rows));
      w.appendChild(q);
    });
  }

""" + screens[an_end:]

# --- one block behind one cell: the feed and the schedule -------------------
# Neither is something an owner opens the panel FOR — one is a schedule that
# mostly does not change, the other a stream you watch only when something is
# wrong — and between them they took a cell and the whole leftover height of
# home. Behind one cell they cost a line, and home is a grid again.
screens=screens.replace("function headingFor(view,d){",
  "function infraScreen(w,d){\n"
  "  // The feed first: it is the half that changes while you are looking at it.\n"
  "  // rightNowCell brings its own poll, and closing the panel clears it.\n"
  "  w.appendChild(rightNowCell(d));\n"
  "  if(!d.jobs.length){\n"
  "    w.appendChild(pad('Nothing scheduled','Nothing runs on its own yet.'));\n"
  "    return w;\n"
  "  }\n"
  "  var jp=pad('On a schedule','What runs without anyone asking.');\n"
  "  jp.appendChild(listOf(d.jobs.map(function(j){\n"
  "    var name=j.name||j.id||'job', bad=j.state&&j.state!=='ENABLED';\n"
  "    return li({lead:'\\u25F4',warm:bad,title:name,meta:j.schedule||'no schedule',\n"
  "               pill:pill(bad?(j.state||'paused'):'on', bad?'bad':'good')});\n"
  "  })));\n"
  "  w.appendChild(jp); return w;\n"
  "}\n\n"
  "function headingFor(view,d){")
screens=screens.replace("  return w;\n}\n\nfunction infraScreen",
                        "  if(key==='infra') return infraScreen(w,d);\n\n  return w;\n}\n\nfunction infraScreen")

feed=S('feed')

# --- the feed is live, not a loop -----------------------------------------
# v5 faked liveness: tick walked rows[i % rows.length] every 2.2s, so the same
# eight lines scrolled forever. On a real app that is invented traffic. This
# re-reads /_xray instead and repaints, at the cadence the old x-ray polled at.
old_tick = feed[feed.index('  var i=0;'):feed.index('  return c;\n}')]
new_tick = """  function paint(list){
    feed.innerHTML='';
    if(!list.length){ feed.appendChild(el('p','none','Nothing yet.')); return; }
    list.slice(0,9).forEach(function(r){ feed.appendChild(feedRow(r,ago(0))); });
  }
  paint(rows);
  clearInterval(dwFeedTimer);
  dwFeedTimer=setInterval(function(){
    dwLive().then(function(live){
      if(!live||!live.live||!dw) return;
      var next=(live.live.paths||[]).slice(0,40).map(function(p){
        return ['edge',p.path,(p.hits+' - '+p.p50+'ms - '+ago(p.ago)),p.brokenFor?'bad':''];
      });
      if(dwD) dwD.feed=next;
      paint(next.filter(function(r){ return feedOn[r[0]]; }));
    });
  },3000);
"""
assert old_tick.strip().startswith('var i=0;'), 'feed tick not found'
feed = feed.replace(old_tick, new_tick)

# --- only offer filters for sources the data actually has ------------------
# The prototype drew five (edge/web/api/db/redis). The proxy hears the edge and
# nothing else, so four of those buttons could only ever empty the list.
feed = feed.replace("  var bar=el('div','filters');\n  SOURCES.forEach(function(src){",
  "  var present=SOURCES.filter(function(s){ return all.some(function(r){ return r[0]===s; }); });\n"
  "  var bar=el('div','filters');\n  if(present.length>1) present.forEach(function(src){")
feed = feed.replace("    bar.appendChild(b);\n  });\n  c.appendChild(bar);",
  "    bar.appendChild(b);\n  });\n  if(present.length>1) c.appendChild(bar);")

# The dimensions, ordered as a person asks them rather than as umami lists them,
# with the words they are read under. Mirrors DIMENSION_LABELS in analytics.ts.
DW_DIMS_JS = ("var DW_DIMS=[['pages','Most opened'],['entry','Where they came in'],"
  "['exit','Where they left'],['from','How they got here'],['country','Country'],"
  "['region','Region'],['city','City'],['browser','Browser'],['os','Operating system'],"
  "['on','Device'],['screen','Screen size'],['language','Language'],"
  "['titles','By page title'],['query','Search terms'],['hosts','Which address they used'],"
  "['event','Events'],['tag','Tags']];\n")
titles=S('titles').replace("access:'People'}", "access:'Access', infra:'Infra', agent:'Agent'}")

# --- home gets one Infra cell where Jobs and the feed used to be ------------
cells=S('cells')
anchor="  g.appendChild(cell('Access','Who can open this'"
assert anchor in cells
cells=cells.replace(anchor,
  "  var infraPart=el('div','chips');\n"
  "  infraPart.appendChild(statusChip(d.feed.length ? d.feed.length+' live' : 'quiet',\n"
  "                                   d.alert ? 'red' : 'green'));\n"
  "  if(d.jobs.length) infraPart.appendChild(statusChip(d.jobs.length+(d.jobs.length===1?' job':' jobs'),'green'));\n"
  "  g.appendChild(cell('Infra','What it is doing, and what runs on its own',\n"
  "    infraPart, function(){ dwPush({v:'infra'}); }));\n\n"+anchor)

# home no longer carries the feed itself; it lives behind Infra now.
cells=cells.replace("  wrap.appendChild(rightNowCell(d));\n", "")
assert "rightNowCell" not in cells, "the feed must not still be built on home"

# --- Agent: the other bookend --------------------------------------------
# Address is where it lives; Agent is how you work on it. Both full width, at
# either end of six half-width readings, because both hold something you copy
# rather than a number you read.
#
# One cell and not two. Every coding agent needs the CLI to deploy and MCP is an
# extra surface on top of it for the chat-shaped tools, so CLI and MCP are
# layered rather than parallel — and two sibling cells would read as "pick one",
# which is the one thing that is not true. It is also one question: how do I
# point my agent at this app.
cells=cells.replace("  var wrap=el('div','home');",
  "  var agPart=el('div','chips');\n"
  "  var agLast=dwLastAgent(d);\n"
  "  agPart.appendChild(statusChip(\n"
  "    agLast!==null ? 'connected' : (d.tokens.length ? 'never used' : 'not connected'),\n"
  "    agLast!==null ? 'green' : 'red'));\n"
  "  g.appendChild(cell('Agent',\n"
  "    agLast!==null ? 'A token last reached us '+ago(Math.round((Date.now()-agLast)/1000))\n"
  "                  : d.tokens.length ? 'You have a token; nothing has used it yet'\n"
  "                  : 'Give your coding agent a way in',\n"
  "    agPart, function(){ dwPush({v:'agent'}); }, true));\n\n"
  "  var wrap=el('div','home');")

# --- the Agent screen ------------------------------------------------------
# A tool picker, and then exactly what that tool can use. Nobody thinks "I need
# MCP" — they think "I use Cursor" — so the panel does the protocol mapping
# rather than making the reader do it. Every tool gets the CLI, because that is
# what deploys; the ones that speak MCP are told it is not built yet instead of
# being handed a config that points at nothing.
screens=screens.replace("function headingFor(view,d){",
  "var DW_TOOLS=[['claude-code','Claude Code',false],['cursor','Cursor',true],"
  "['codex','Codex',false],['claude','Claude',true],['chatgpt','ChatGPT',true],"
  "['other','Other',false]];\n"
  "var dwTool='claude-code';\n\n"
  "function agentScreen(w,d){\n"
  "  var tp=pad('Which tool','It all goes through the CLI. Some can also talk to us directly.');\n"
  "  var seg=el('div','seg');\n"
  "  DW_TOOLS.forEach(function(t){\n"
  "    var b=el('button',null,t[1]);\n"
  "    b.setAttribute('aria-pressed', dwTool===t[0] ? 'true':'false');\n"
  "    b.addEventListener('click',function(){ dwTool=t[0]; dwRender(); });\n"
  "    seg.appendChild(b);\n"
  "  });\n"
  "  tp.appendChild(seg);\n"
  "  w.appendChild(tp);\n"
  "\n"
  "  var tool=DW_TOOLS.filter(function(t){ return t[0]===dwTool; })[0];\n"
  "\n"
  "  // Always the CLI: it is what ships, whatever is driving it.\n"
  "  var ip=pad('Install it','Once per machine.');\n"
  "  ip.appendChild(tintRow('npm i -g @supersonic/cli'));\n"
  "  w.appendChild(ip);\n"
  "  var lp=pad('Sign in','Opens a browser once, then the agent has a token.');\n"
  "  lp.appendChild(tintRow('supersonic login'));\n"
  "  w.appendChild(lp);\n"
  "  var dp=pad('Ship this app','From the folder the code is in.');\n"
  "  dp.appendChild(tintRow('supersonic deploy --app '+d.slug));\n"
  "  w.appendChild(dp);\n"
  "\n"
  "  if(tool && tool[2]){\n"
  "    // Said plainly rather than shipped half-built. A config block here would\n"
  "    // point a working tool at a server that does not exist.\n"
  "    w.appendChild(pad('Talking to us directly',\n"
  "      tool[1]+' can hold a connection to us as well as run the CLI. That is not\\n"
  " built yet — when it is, the setup for it appears here.'));\n"
  "  }\n"
  "\n"
  "  var kp=pad('Tokens', d.tokens.length ? 'One token deploys everything you own, so this is the last time each was used at all — not on this app.' : 'You have not made one yet. Run the sign-in above and it appears here.');\n"
  "  if(d.tokens.length){\n"
  "    kp.appendChild(listOf(d.tokens.map(function(t){\n"
  "      var used=t.last_used_at ? Date.parse(t.last_used_at) : NaN;\n"
  "      var rm=btn('Revoke','trash-2',{rest:'white',hover:'red',size:'sm'});\n"
  "      rm.addEventListener('click',function(){\n"
  "        if(!confirm('Revoke this token? Any agent using it stops being able to ship.')) return;\n"
  "        dwPost('/agent',{revoke:t.id}).then(function(j){\n"
  "          if(j&&j.tokens){ d.tokens=j.tokens; dwRender(); }\n"
  "        });\n"
  "      });\n"
  "      return li({lead:'\\u2691', title:t.name||'unnamed token',\n"
  "                 meta:isFinite(used) ? 'last used '+ago(Math.round((Date.now()-used)/1000)) : 'never used',\n"
  "                 pill:rm});\n"
  "    })));\n"
  "  }\n"
  "  w.appendChild(kp);\n"
  "  return w;\n"
  "}\n\n"
  "function headingFor(view,d){")
screens=screens.replace("  if(key==='infra') return infraScreen(w,d);",
                        "  if(key==='infra') return infraScreen(w,d);\n  if(key==='agent') return agentScreen(w,d);")

extra_css = """
/* ------------------- the panel as an overlay, not a page ------------------ */
/* v5 was a page that toggled [hidden]; injected into someone else's app it has
   to arrive from the edge it lives on, over a scrim that takes the click. */
/* The base type lives HERE and not on :host, because inject.ts sets
   all:initial INLINE on the host element and an inline declaration beats an
   author rule — a :host font-family rule is silently discarded. On .drawer it is a
   normal class rule that inherits down the panel, and a mono ancestor still
   wins for its own children. This is what was missing when every heading came
   out in the browser's default serif. */
.drawer{font-family:var(--sans);font-size:15px;line-height:1.4;color:var(--ink);
        -webkit-font-smoothing:antialiased}
.drawer{transform:translateX(100%);transition:transform .24s var(--ease);
        z-index:2147483001;box-shadow:-24px 0 60px -30px rgba(0,0,0,.35)}
.drawer.on{transform:none}
.drawer.flat{position:static;width:100%;height:100%;transform:none;box-shadow:none;border-left:0}
/* ------------------------- cards on a quiet ground ----------------------- */
/* The sheet was white with the ground showing through 1px gaps as the lines
   between cells. Direction C separates them properly: each cell is a card with
   its own hairline and radius, and the ground behind them steps down one value
   to #fafafa so a card reads as a card. That step is the whole trick — at
   #ffffff on #ffffff the border does all the work and the panel flattens.
   Screens get the same treatment: pads become cards with gaps rather than
   sections divided by rules. */
.drawer,.scroll{background:var(--ground)}
.head{background:var(--white);border-bottom:1px solid var(--line)}
.cells{background:transparent}
.screen{background:transparent;gap:12px;padding:16px}
.pad{border:1px solid var(--line);border-radius:var(--r-xl)}
/* The feed keeps its own frame for the same reason every other block has one. */
.cell.grow{min-height:0}

/* ------------------------- the window's shape ---------------------------- */
/* The only chart here. Columns and not a line, because a line between two hours
   claims a value for the minutes in between that nothing measured. */
.spark{display:flex;align-items:flex-end;gap:2px;height:96px;margin-top:4px}
.spark .col{flex:1;min-width:2px;height:100%;display:flex;align-items:flex-end;
            border-radius:2px;background:var(--tile)}
.spark .col .f{width:100%;background:var(--red);border-radius:2px;opacity:.85}
.spark .col:hover .f{opacity:1}

.dw-scrim{position:fixed;inset:0;background:rgba(26,26,25,.28);opacity:0;
          transition:opacity .24s var(--ease);z-index:2147483000}
.dw-scrim.on{opacity:1}
@media (prefers-reduced-motion:reduce){
  .drawer,.dw-scrim{transition:none}
  .scroll.push,.scroll.pop{animation:none}
}
"""

header = '''// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Built by ../panel/compose.py from the sources beside it: panel.css for the
// stylesheet, and the .js slices for the component code (icons, helpers, atoms,
// cells, feed, screens) plus layer.js for the data layer this product added.
// Most of the component code is the recovered 12 Aug prototype's own source,
// sliced rather than retyped, so the design cannot drift from what was approved.
//
//   python3 services/proxy/panel/compose.py
//
// Editing drawer.ts directly works until the next person runs that, at which
// point the edit is silently gone. Edit the source and re-run.

/**
 * The panel: everything an owner can do to their app, inside the app.
 *
 * WHAT THIS REPLACES
 *
 * A dark 460px drawer with a row of tabs — X-ray, Data, Files, Jobs, Secrets,
 * Address, Share — each of which fetched only once you clicked it. It worked and
 * it read as a developer tool bolted to the side of somebody's app.
 *
 * This is the recovered `bay-panel` prototype instead: white cells on a grey
 * ground, one fact per cell, and a tap pushes into the screen behind it. The
 * difference that matters is not the colour. Tabs make you find the thing that
 * is wrong; cells tell you. Home says how many tables, how many keys, who is
 * here and what shipped, before you have clicked anything — which is only
 * possible because everything is fetched at once, up front (`dwLoad`).
 *
 * WHERE IT CAME FROM
 *
 * `site/index.html` in the 12 Aug session, recovered from that session's
 * transcript after the scratchpad it lived in was wiped. The component
 * functions below — cell, li, pad, btn, bars, screen — are that file's own code,
 * not a reimplementation, so the design cannot drift from what was approved.
 * What is new here is the data layer: the prototype ran on four hardcoded demo
 * apps, and every one of those has been replaced by a real route.
 *
 * NATIVE, NOT AN IFRAME
 *
 * Every screen is drawn here against the control plane's existing JSON APIs. An
 * iframe would have been a day's work instead of this and would have shipped a
 * second scrollbar, a second font stack and a visible seam down the middle of
 * the owner's own app. It also could not live in the shadow root, which is what
 * keeps a tenant's CSS from reaching in and ours from leaking out.
 *
 * OWNER ONLY, AS SOURCE
 *
 * This whole file is emitted only inside the `owner ? OWNER_JS : ""` branch in
 * inject.ts. A visitor is not served it and cannot read it out of the page —
 * the same rule the toolbar keeps, and the reason the analytics tracker is
 * deliberately OUTSIDE that branch while all of this is inside it.
 *
 * FONTS
 *
 * The tokens ask for Geist and fall back to system-ui. @font-face cannot be
 * declared inside a shadow root, so on a tenant origin the fallback is what
 * renders. That is deliberate for now: the alternative is injecting a font-face
 * into the tenant's own document, which is exactly the leaking-out this design
 * avoids.
 */

export const DRAWER_CSS = String.raw`
'''

body = (css + extra_css + "\n" + XRAY_MARK) if False else None

out = header + css + extra_css + "\n`;\n\n" + \
      "export const DRAWER_JS = String.raw`\n" + \
      S('icons') + "\n\n" + DW_DIMS_JS + "\n" + titles + "\n\n" + S('nav') + "\n\n" + \
      S('helpers') + "\n\n" + S('atoms') + "\n\n" + cells + "\n\n" + \
      feed + "\n\n" + screens + "\n\n" + S('layer') + "\n`;\n"

# Written beside this file's own package, so the generator works from any
# checkout rather than one person's home directory.
pathlib.Path(__file__).resolve().parent.parent.joinpath('src', 'drawer.ts').write_text(out)
_body = out[out.index('String.raw'):]
_lit = _body.replace('String.raw`','',2)
import re as _re
_inside = out.split('String.raw`')[1].rsplit('`;',1)[0] + out.split('String.raw`')[2].rsplit('`;',1)[0]
assert '`' not in _inside, 'a backtick reached inside String.raw'
assert 'XRAY' not in out, 'the old x-ray module must be gone'
print('drawer.ts written:', len(out), 'bytes')
print('backticks in body:', out.count('`') )
