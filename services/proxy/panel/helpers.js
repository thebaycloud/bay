function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;}
var isMetal=function(s){ return s==='steel' || s==='red'; };

/**
 * The button, as the component builds it: a rest surface and a hover surface
 * that cross-fade, a lit top edge belonging to whichever end is metal, an
 * invisible in-flow copy of the label to give the button its width, and two
 * absolutely-placed copies that roll.
 */
function btn(label,iconName,opts){
  opts = opts || {};
  var rest = opts.rest || 'white', to = opts.hover || rest, size = opts.size || 'md';
  var b = el('button','btn '+size+' r-'+rest+(to!==rest ? ' h-'+to+' fades' : ''));

  if(isMetal(rest)){
    var p=el('span','plate rest '+rest);
    p.style.backgroundImage='url('+PLATE[rest]+')';
    b.appendChild(p);
  }
  if(isMetal(to) && to!==rest){
    var p2=el('span','plate to '+to);
    p2.style.backgroundImage='url('+PLATE[to]+')';
    b.appendChild(p2);
  }
  if(isMetal(rest) || isMetal(to)){
    var lit=el('span','lit'+(isMetal(rest)?'':' off')+(isMetal(to)?' on-hover':' off-hover'));
    b.appendChild(lit);
  }

  var ico = size==='sm' ? 15 : 16;
  function content(cls,hide){
    var s=el('span',cls);
    if(hide) s.setAttribute('aria-hidden','true');
    if(iconName) s.appendChild(icon(iconName,ico));
    s.appendChild(el('span',null,label));
    return s;
  }
  b.appendChild(content('ghost',true));
  b.appendChild(content('roll a'));
  b.appendChild(content('roll b',true));
  return b;
}

function kv(rows,onTap){
  var t=el('table','kv');
  rows.forEach(function(r,i){
    var tr=el('tr');
    if(onTap){ tr.className='tap'; tr.addEventListener('click',function(){onTap(i);}); }
    tr.appendChild(el('td','k',r[0]));
    tr.appendChild(el('td','v'+(r[2]?' '+r[2]:''),r[1]));
    if(onTap){ var g=el('td','go'); g.appendChild(icon('chevron-right',14)); tr.appendChild(g); }
    t.appendChild(tr);
  });
  return t;
}

/** Machine values live here and nowhere else — addresses, keys, commands. */
function tintRow(value){
  var w=el('div','tint');
  w.appendChild(el('div','v',value));
  [['Reveal','eye'],['Copy','copy']].forEach(function(p){
    var b=el('button','icon');
    b.setAttribute('aria-label',p[0]);
    b.appendChild(icon(p[1],16));
    w.appendChild(b);
  });
  return w;
}

function avatars(list){
  var w=el('div','avs');
  list.forEach(function(s){ w.appendChild(el('span','av',s)); });
  return w;
}
function statusChip(text,tone){
  var s=el('span','chip t-micro');
  s.appendChild(el('span','dot '+tone));
  s.appendChild(el('span',null,text));
  return s;
}
