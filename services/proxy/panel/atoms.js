function bars(rows){
  var w=el('div','bars');
  var max=rows.reduce(function(m,r){ return Math.max(m,r[1]); },1);
  rows.forEach(function(r){
    var line=el('div','r');
    var track=el('div','track');
    var fill=el('span','fill');
    fill.style.width=Math.round(r[1]/max*100)+'%';
    track.appendChild(fill);
    track.appendChild(el('span','t',r[0]));
    line.appendChild(track);
    line.appendChild(el('span','c', r[1].toLocaleString()));
    w.appendChild(line);
  });
  return w;
}

function stat(n,l,delta,up){
  var s=el('div','stat');
  s.appendChild(el('div','n',n));
  s.appendChild(el('div','l',l));
  if(delta) s.appendChild(el('div','d'+(up?'':' down'), delta+' vs last week'));
  return s;
}

/** A section of a screen: a white cell on the ground, with a heading it owns. */
function pad(title,note,grow){
  var w=el('div','pad'+(grow?' grow':''));
  if(title) w.appendChild(el('div','sec-h',title));
  if(note)  w.appendChild(el('div','sec-n',note));
  return w;
}

/**
 * One row. Something to look at, the thing it is, the fact about it.
 *
 * Everything used to be a two-column mono table, which made a person's name and
 * a row count the same kind of object. Mono is for machine values; a name, a
 * table and a page title are read, not parsed.
 */
function li(o){
  var r=el(o.onTap?'button':'div','li'+(o.prop!=null?' has-prop':''));
  if(o.lead!=null){
    var L=el('div','lead'+(o.round?' round':'')+(o.warm?' warm':''));
    if(typeof o.lead==='string') L.textContent=o.lead; else L.appendChild(o.lead);
    r.appendChild(L);
  } else r.appendChild(el('span'));

  var tt=el('div','tt');
  tt.appendChild(el('div','n1',o.title));
  if(o.meta) tt.appendChild(el('div','n2',o.meta));
  r.appendChild(tt);

  if(o.pill) r.appendChild(o.pill);
  else if(o.val!=null) r.appendChild(el('div','val'+(o.tone?' '+o.tone:''),o.val));
  else r.appendChild(el('span'));

  if(o.onTap){
    var c=el('span','caret'); c.appendChild(icon('chevron-right',15));
    r.appendChild(c);
    r.addEventListener('click',o.onTap);
  } else r.appendChild(el('span'));

  if(o.prop!=null){
    var pr=el('div','prop'); var f=el('i'); f.style.width=Math.round(o.prop*100)+'%';
    pr.appendChild(f); r.appendChild(pr);
  }
  return r;
}

function pill(text,kind){
  var s=el('span','pill'+(kind?' '+kind:''));
  if(kind==='live') s.appendChild(el('i'));
  s.appendChild(el('span',null,text));
  return s;
}

function listOf(rows){
  var w=el('div','list');
  rows.forEach(function(r){ w.appendChild(r); });
  return w;
}

/** Initials from an address, so a row has something to look at. */
function ini(x){
  var n=x.split('@')[0].replace(/[^a-z]/gi,'');
  return (n.slice(0,2) || '··').toUpperCase();
}