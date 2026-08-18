var SOURCES=['edge','web','api','db','redis'];
var feedOn=null;

function feedRow(r,when){
  var f=el('div','f '+r[0]+(r[3]?' '+r[3]:''));
  f.appendChild(el('span','src',r[0]));
  var m=el('span','msg',r[1]);
  m.title=r[1];
  f.appendChild(m);
  f.appendChild(el('span','meta', r[2] ? r[2] : when));
  return f;
}

/**
 * The cell that takes the leftover height.
 *
 * Deliberately a stream and not a chart: the edge keeps nothing older than this
 * process, so a graph here would be inventing a past it does not have. Trends
 * live in Analytics, which has a database behind it.
 */
function rightNowCell(d){
  var all=d.feed||[];
  var c=el('div','cell wide grow');
  c.appendChild(el('div','t-section','Right now'));
  c.appendChild(el('div','t-sub', all.length
    ? 'Everything your app is saying, as it says it'
    : 'Nothing has been asked of it yet'));
  if(!all.length) return c;

  if(feedOn===null) feedOn={edge:1,web:1,api:1,db:1,redis:1};

  var bar=el('div','filters');
  SOURCES.forEach(function(src){
    var b=el('button',null,src);
    b.setAttribute('aria-pressed', feedOn[src] ? 'true':'false');
    b.addEventListener('click',function(ev){
      ev.stopPropagation();
      feedOn[src]=!feedOn[src];
      dwRender();
    });
    bar.appendChild(b);
  });
  c.appendChild(bar);

  var rows=all.filter(function(r){ return feedOn[r[0]]; });
  var feed=el('div','feed');
  c.appendChild(feed);
  if(!rows.length){
    feed.appendChild(el('p','none','Nothing from those. Turn one back on.'));
    return c;
  }

  var i=0;
  function tick(){
    var r=rows[i % rows.length]; i++;
    feed.insertBefore(feedRow(r,'just now'), feed.firstChild);
    while(feed.children.length>9) feed.removeChild(feed.lastChild);
  }
  for(var k=0;k<6;k++) tick();
  clearInterval(dwFeedTimer);
  dwFeedTimer=setInterval(tick,2200);
  return c;
}

/** A labelled bar row — the only chart shape here, and it needs no time axis. */