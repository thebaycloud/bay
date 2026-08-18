function cell(title,sub,part,onOpen,wide){
  var c=el(onOpen?'button':'div','cell'+(wide?' wide':''));
  c.appendChild(el('div','t-section',title));
  c.appendChild(el('div','t-sub',sub));
  if(part){ var p=el('div','part'); p.appendChild(part); c.appendChild(p); }
  if(onOpen){
    var g=el('span','go'); g.appendChild(icon('chevron-right',16));
    c.appendChild(g);
    c.addEventListener('click',onOpen);
  }
  return c;
}

function alertCell(d){
  var c=el('div','cell tinted');
  c.appendChild(el('div','t-section',d.alert.title));
  c.appendChild(el('div','t-micro',d.alert.sub));
  var p=el('div','part');
  var b=btn(d.alert.act, d.alert.icon, {rest:'red', hover:'white'});
  b.addEventListener('click',function(){
    var lbl=b.querySelectorAll('.roll span:last-child, .ghost span:last-child');
    if(d.alert.kind!=='brief'){
      Array.prototype.forEach.call(lbl,function(n){n.textContent='Copied';});
      return;
    }
    if(c.querySelector('.brief')) return;
    var ta=el('textarea','brief'); ta.value=briefText(d); ta.readOnly=true;
    c.appendChild(ta); ta.select();
    Array.prototype.forEach.call(lbl,function(n){n.textContent='Copied — paste it to your agent';});
  });
  p.appendChild(b);
  c.appendChild(p);
  return c;
}

// ------------------------------------------------------------------- home
function homeScreen(d){
  var g=el('div','cells');
  if(d.alert) g.appendChild(alertCell(d));   // always the full width

  // Analytics | Ships — who is using it, and what changed
  var anPart=null;
  if(d.an){
    anPart=el('div','chips');
    anPart.appendChild(statusChip(d.an.visitors.toLocaleString()+' visitors',
                                  d.an.dvUp?'green':'red'));
    if(d.here.length) anPart.appendChild(avatars(d.initials));
  }
  g.appendChild(cell('Address','Where it lives', tintRow(d.addr), null, true));

  g.appendChild(cell('Analytics',
    d.an ? (d.an.visitors+' today'+(d.an.dv?' '+d.an.dv:'')+' - '+d.here.length+' here now')
         : (d.here.length ? d.here.length+' here now' : 'Not counting yet'),
    anPart, function(){ dwPush({v:'analytics'}); }));

  var shipPart=el('div','chips');
  // The re-ship button is gone. There was no route behind it — it never did
  // anything — and a dead control on the one screen about shipping is worse
  // than no control. The chip still says which state this app is in.
  shipPart.appendChild(statusChip(d.shipping?'Shipping':'Running', d.shipping?'red':'green'));
  g.appendChild(cell('Ships','Last shipped '+d.ships[0].when, shipPart,
    function(){ dwPush({v:'ships'}); }));

  // Data | Keys — what it keeps, what it reaches for
  g.appendChild(cell('Data',"Its data and files",
    btn('Open','arrow-right',{rest:'white',hover:'steel'}), function(){ dwPush({v:'data'}); }));

  var keyPart=el('div','chips');
  d.keys.slice(0,3).forEach(function(k){
    keyPart.appendChild(statusChip(k.name, k.tone==='bad'?'red':'green'));
  });
  g.appendChild(cell('Keys',
    d.keys.length ? 'What it connects to' : 'Nothing connected yet',
    d.keys.length?keyPart:null, function(){ dwPush({v:'keys'}); }));

  var pPart=el('div','chips');
  if(d.pInitials.length) pPart.appendChild(avatars(d.pInitials));
  pPart.appendChild(btn('Invite','plus',{rest:'white',hover:'steel',size:'sm'}));
  // Half width, not wide: Access pairs with Infra on one row. And it is Access,
  // which is what the screen behind it has always been called and what the row
  // is actually about — People named the avatars on it rather than the question.
  g.appendChild(cell('Access','Who can open this', pPart, function(){ dwPush({v:'access'}); }));


  var wrap=el('div','home');
  wrap.appendChild(g);
  wrap.appendChild(rightNowCell(d));
  return wrap;
}

/**
 * The cell that takes the leftover height.
 *
 * Deliberately the live feed and not a chart: the edge keeps nothing older than
 * this process, so any graph drawn here would be inventing a past it does not
 * have. What it does have is every request as it lands.
 */
/**
 * One stream, five sources.
 *
 * The edge line and the lines the app itself printed are the same story told at
 * two depths — the edge knows WHAT failed and when, the app's own output knows
 * WHY. Every competitor puts those on separate screens, which is why finding a
 * cause there means holding two timestamps in your head. Here they interleave,
 * so the request and the dwStack it produced are adjacent by construction.
 */