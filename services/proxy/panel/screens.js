function screen(view,d){
  var w=el('div','screen'), key=view.v;

  // ------------------------------------------------------------- analytics
  if(key==='analytics'){
    if(!d.an){
      var p0=pad('Nobody yet','Your app is live. Nothing has been opened.');
      w.appendChild(p0); return w;
    }
    var top=pad(null,null);
    var st=el('div','stats');
    st.appendChild(stat(d.an.visitors.toLocaleString(),'visitors this week',d.an.dv,d.an.dvUp));
    st.appendChild(stat(d.an.views.toLocaleString(),'pages opened'));
    st.appendChild(stat(d.an.mins,'average visit'));
    st.appendChild(stat(d.an.returning,'came back'));
    top.appendChild(st);
    w.appendChild(top);

    var hp=pad('In it right now', d.here.length ? null : 'Nobody this second.');
    if(d.here.length){
      hp.appendChild(listOf(d.here.map(function(h){
        var signed=h[0].indexOf('@')>0;
        return li({lead:signed?ini(h[0]):'··', round:true,
                   title:signed?h[0].split('@')[0]:h[0],
                   meta:signed?h[0]:'no account', val:h[1]});
      })));
    }
    w.appendChild(hp);

    var pp=pad('Most opened','Which pages people actually reach.');
    pp.appendChild(bars(d.an.pages)); w.appendChild(pp);
    var fp=pad('How they got here');
    fp.appendChild(bars(d.an.from)); w.appendChild(fp);
    var op=pad('What they are on', d.missing || null);
    op.appendChild(bars(d.an.on)); w.appendChild(op);
  }

  // ----------------------------------------------------------------- ships
  if(key==='ships'){
    // One ship, said properly, rather than a list of one pretending to be
    // history. deploy-status answers with the LATEST deploy and nothing else, so
    // "Every change · Newest first" was a heading over a single row, and tapping
    // it opened a detail screen that repeated the row and then admitted it had
    // nothing else to show. There is no deploys-list route yet; when there is,
    // this becomes the list it was drawn as.
    var s1=d.ships[0];
    var head=pad(s1.did, s1.when);
    head.appendChild(listOf([
      li({lead:ini(s1.who), round:true, title:s1.who, meta:'made this change',
          pill:pill(s1.out, s1.out==='shipped'?'good':s1.out==='never left'?'bad':'live')})
    ]));
    w.appendChild(head);

    if(s1.error){
      // The reason it did not land, verbatim. This is the one thing an owner
      // opens this screen to read, and it was not on it.
      var ep=pad('Why it did not land', null);
      ep.appendChild(el('p','t-micro', String(s1.error).slice(0,600)));
      w.appendChild(ep);
    }

    var facts=pad('The ship itself', null);
    var rows=[li({lead:'\u25CF', title:'Outcome', meta:'what the platform recorded', val:s1.status||'unknown'})];
    if(s1.stage) rows.push(li({lead:'\u25D4', title:'Last step', meta:'the furthest it got', val:s1.stage}));
    rows.push(li({lead:'\u2751', title:'Address', meta:'where this release answers', val:d.addr}));
    facts.appendChild(listOf(rows));
    w.appendChild(facts);

    w.appendChild(pad('Older ships', 'Only the most recent one is kept where this panel can read it.'));
  }

  // ------------------------------------------------------------------ data
  if(key==='data'){
    if(view.t){
      var rp=pad(view.t,'1,204 rows · the newest three');
      rp.appendChild(listOf([
        li({lead:'#',title:'Groceries',meta:'Oat milk, bread, the good coffee.',val:'1204'}),
        li({lead:'#',title:'Call the bank',meta:'About the card that keeps getting declined.',val:'1203'}),
        li({lead:'#',title:'Bay bridge photos',meta:'The ones from the ferry.',val:'1202'})
      ]));
      w.appendChild(rp); return w;
    }
    if(!d.tables.length){
      w.appendChild(pad('Nothing stored yet','Your app has not written anything down.'));
      return w;
    }
    var max=d.tables.reduce(function(m,t){return Math.max(m,t[1]);},1);
    var tp=pad('Your data', d.tables.length+' tables. The bar is how much of your data each one is.');
    tp.appendChild(listOf(d.tables.map(function(t){
      return li({lead:'\u25A6', title:t[0],
                 meta:t[1] ? 'last written '+(t[0]==='notes'?'2 minutes':'yesterday')+' ago' : 'never written to',
                 val:t[1] ? t[1].toLocaleString()+' rows' : 'empty',
                 prop:t[1]/max,
                 onTap:function(){ dwPush({v:'data',t:t[0]}); }});
    })));
    w.appendChild(tp);
    var fp2=pad('Your files','Anything your app has uploaded.');
    fp2.appendChild(listOf([li({lead:'\u2751',title:'uploads/',meta:'images and attachments',val:d.files})]));
    w.appendChild(fp2);
  }

  // ------------------------------------------------------------------ keys
  if(key==='keys'){
    if(view.i != null){
      var k=d.keys[view.i];
      var kp=pad(null,null);
      var box=el('div','block'); box.style.marginTop='0';
      box.appendChild(el('p',null,k.detail.title));
      box.appendChild(el('small',null,k.detail.sub));
      box.appendChild(btn(k.detail.act,k.detail.icon,{rest:'red',hover:'white'}));
      kp.appendChild(box);
      w.appendChild(kp);
      w.appendChild(pad('Why we know','Your app calls Stripe through us, so we see the answer it gets back. Nobody had to add anything to your code.'));
      return w;
    }
    if(!d.keys.length){
      w.appendChild(pad('Nothing connected','Your app does not talk to anything outside itself yet.'));
      return w;
    }
    var kp2=pad('Connected','We can tell you whether a key works, because we watch your app use it.');
    kp2.appendChild(listOf(d.keys.map(function(k,i){
      var bad=k.tone==='bad', never=!k.tone;
      return li({lead:k.name.slice(0,2), warm:bad, title:k.name,
                 meta:bad?'your app cannot reach it':never?'no call has been made yet':'answering normally',
                 pill:pill(k.st, bad?'bad':never?'':'good'),
                 onTap:k.detail?function(){ dwPush({v:'keys',i:i}); }:null});
    })));
    w.appendChild(kp2);
  }

  // ---------------------------------------------------------------- people
  if(key==='access'){
    var vp=pad('Who can open it', null);
    var seg=el('div','seg');
    [['private','Only me'],['shared','People I add'],['public','Anyone']].forEach(function(o){
      var b=el('button',null,o[1]);
      b.setAttribute('aria-pressed', d.who===o[0] ? 'true':'false');
      b.addEventListener('click',function(){ d.who=o[0]; dwRender(); });
      seg.appendChild(b);
    });
    vp.appendChild(seg);
    vp.appendChild(el('p','seg-n', d.who==='public'
      ? 'Anyone with the address sees your app. They never see this panel.'
      : d.who==='shared' ? 'Only the people below, after they sign in.'
      : 'Nobody but you, on any device you sign in from.'));
    w.appendChild(vp);

    var pp2=pad('People', d.people.length ? null : 'You have not added anyone.');
    if(d.people.length){
      pp2.appendChild(listOf(d.people.map(function(x){
        return li({lead:ini(x), round:true, title:x.split('@')[0], meta:x, val:'can open'});
      })));
    }
    var inv=btn('Invite','plus',{rest:'white',hover:'steel',size:'sm'});
    inv.style.marginTop=d.people.length?'14px':'4px';
    pp2.appendChild(inv);
    w.appendChild(pp2);

    var ap=pad('Address','Where it lives. Send this to anyone.');
    ap.appendChild(tintRow(d.addr));
    w.appendChild(ap);

    var dp2=pad('Delete','The app, its data and its files. There is no undo.');
    dp2.appendChild(btn('Delete this app','trash-2',{rest:'white',hover:'red',size:'md'}));
    w.appendChild(dp2);
  }

  return w;
}

function headingFor(view,d){
  if(view.v==='ships' && view.i!=null) return d.ships[view.i].when;
  if(view.v==='data'  && view.t)       return view.t;
  if(view.v==='keys'  && view.i!=null) return d.keys[view.i].name;
  return TITLES[view.v];
}
