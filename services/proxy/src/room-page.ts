import { escapeHtml } from "./pages";

/**
 * The room.
 *
 * An app's address answers before the app does, and until now what it answered
 * was a dark page reading "Deploying…" that reloaded itself every three seconds.
 * This is what stands there instead: the build, drawn, at the app's own address,
 * for the owner and for anyone they sent the link to.
 *
 * THE RULE. Every movement on screen stands for one real line from the build. The
 * agent does not walk to fill time, and when nothing is happening the room says
 * so — see the `quiet` branch. A room that animates over silence is a preloader
 * with a character in it, and it stops being worth looking at the second anyone
 * works that out.
 *
 * THE ART IS A PLACEHOLDER. Everything here is drawn with fillRect at a 160×90
 * internal resolution and scaled up with image-rendering:pixelated. It is honest
 * about what it shows and it is not the finished thing: a commissioned sprite set
 * (room, one character with four states, crate, door, lamp) replaces `paint` and
 * nothing else. The internal resolution exists so that swap is a swap.
 */
export function pageRoom(slug: string, opts: { owner: boolean }): string {
  const { owner } = opts;
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(slug)} — building</title>
<style>
  :root{--bg:#0e1512;--ink:#e9efeb;--dim:#6d7d74;--go:#2ea86a}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);
       font:14px/1.5 ui-monospace,"SF Mono",Menlo,monospace;
       display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px}
  #stage{width:min(92vw,720px);aspect-ratio:16/9;border-radius:14px;overflow:hidden;
         box-shadow:0 20px 60px rgba(0,0,0,.5);background:#0a100e}
  canvas{width:100%;height:100%;display:block;image-rendering:pixelated}
  .bar{width:min(92vw,720px);display:flex;gap:12px;align-items:baseline;justify-content:space-between;
       color:var(--dim);font-size:12px;min-height:18px}
  #line{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  #here{white-space:nowrap}
  #name{color:var(--ink)}
  #hint{width:min(92vw,720px);color:var(--dim);font-size:12px;min-height:34px}
  code{background:#1d2621;padding:.1rem .35rem;border-radius:.25rem;color:var(--ink)}
</style>
<div class="bar"><span id="name">${escapeHtml(slug)}</span><span id="here"></span></div>
<div id="stage"><canvas id="c" width="160" height="90"></canvas></div>
<div class="bar"><span id="line"></span></div>
<div id="hint"></div>
<script>
${clientScript(slug, owner)}
</script>`;
}

/**
 * A JS value safe to embed inside a `<script>` block.
 *
 * `JSON.stringify` is not enough on its own: it escapes for JSON, and the HTML
 * parser does not read JSON. A value containing `</script>` closes the tag from
 * inside a string literal and everything after it is markup — which is how a
 * quoted, escaped, apparently-safe string becomes script injection. The line
 * terminators are the other half: U+2028 and U+2029 are legal in JSON strings
 * and illegal in JavaScript ones.
 *
 * `slugFromHost` already rejects anything outside [a-z0-9-], so nothing hostile
 * reaches this today. That is a property of one caller, and this function should
 * not have to know which callers it has.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function clientScript(slug: string, owner: boolean): string {
  const SLUG = jsonForScript(slug);
  const OWNER = owner ? "true" : "false";
  return String.raw`
var SLUG = ${SLUG}, OWNER = ${OWNER};
var c = document.getElementById('c'), g = c.getContext('2d');
var lineEl = document.getElementById('line'), hereEl = document.getElementById('here'), hintEl = document.getElementById('hint');

// ---- palette ----
var P = { wall:'#121b17', floor:'#0a100e', trim:'#1d2621', ink:'#e9efeb', dim:'#3a4b43',
          go:'#2ea86a', warm:'#f0c674', bad:'#d1615d', glow:'#8ef0bb' };

// ---- world ----
// One movement is queued per real build line. Nothing enqueues itself.
var queue = [];
var world = {
  x: 40, dir: 1, phase: 0,          // the agent
  act: 'idle', actUntil: 0,         // what they are doing
  boxes: 0, crates: 0, lamp: 0.25,  // what the room has accumulated
  smoke: 0, quiet: false, opening: 0, opened: false,
  watching: 1
};

function enqueue(steps){
  for (var i=0;i<steps.length;i++) queue.push(steps[i]);
  // A room opened late has a backlog. Movements still map one-to-one onto real
  // lines — they are just performed faster, rather than the agent teleporting
  // through ten minutes of work or the room falling minutes behind the truth.
  if (queue.length > 240) queue.splice(0, queue.length - 240);
}

function nextAction(now){
  if (world.opening) return;
  if (now < world.actUntil) return;
  if (!queue.length) return;
  var step = queue.shift();
  world.quiet = false;
  // Backlog drains faster, but never so fast a movement is invisible.
  var pace = queue.length > 40 ? 110 : queue.length > 12 ? 220 : 420;
  world.act = step.kind;
  world.actUntil = now + pace;
  if (step.kind === 'deps')  world.boxes  = Math.min(world.boxes + 1, 14);
  if (step.kind === 'pull')  world.crates = Math.min(world.crates + 1, 6);
  if (step.kind === 'boot')  world.lamp = Math.min(world.lamp + 0.12, 1);
  if (step.kind === 'broke') world.smoke = 1;
  if (step.text && OWNER) { lineEl.textContent = step.text; }
}

// ---- paint ----
// Replaced wholesale when the sprite set lands. Everything above is the model.
function paint(now){
  var t = now / 1000;
  g.clearRect(0,0,160,90);

  // room
  g.fillStyle = P.wall;  g.fillRect(0,0,160,66);
  g.fillStyle = P.floor; g.fillRect(0,66,160,24);
  g.fillStyle = P.trim;  g.fillRect(0,64,160,2);

  // lamp, brightening as the app comes up
  var lit = world.lamp;
  g.fillStyle = P.trim; g.fillRect(22,8,2,10);
  g.fillStyle = 'rgba(240,198,116,' + (0.25 + lit*0.75).toFixed(3) + ')';
  g.fillRect(18,18,10,4);
  g.fillStyle = 'rgba(240,198,116,' + (0.04 + lit*0.10).toFixed(3) + ')';
  g.beginPath(); g.moveTo(18,22); g.lineTo(4,64); g.lineTo(42,64); g.closePath(); g.fill();

  // shelf, one box per dependency line
  g.fillStyle = P.trim; g.fillRect(96,28,44,2);
  for (var i=0;i<world.boxes;i++){
    var bx = 98 + (i % 7) * 6, by = 22 - Math.floor(i / 7) * 7;
    g.fillStyle = i % 3 ? P.dim : P.go; g.fillRect(bx,by,5,5);
  }

  // crates on the floor, one per pull line
  for (var k=0;k<world.crates;k++){
    g.fillStyle = P.trim; g.fillRect(6 + k*9, 55, 8, 9);
    g.fillStyle = P.dim;  g.fillRect(7 + k*9, 56, 6, 2);
  }

  // the door
  var openAmt = world.opening;
  g.fillStyle = P.trim; g.fillRect(126,30,22,34);
  g.fillStyle = openAmt > 0 ? 'rgba(142,240,187,' + Math.min(openAmt,1).toFixed(3) + ')' : '#0a100e';
  g.fillRect(128,32,18,32);
  if (openAmt > 0){
    g.fillStyle = 'rgba(142,240,187,' + (openAmt*0.5).toFixed(3) + ')';
    g.fillRect(0,0,160,90);
  }

  // the agent
  var a = world.act, bob = Math.sin(t*6) * (a==='idle'||world.quiet ? 0.6 : 1.4);
  if (a === 'deps')  world.x += (118 - world.x) * 0.08;
  else if (a === 'pull')  world.x += (18 - world.x) * 0.08;
  else if (a === 'build') world.x += (68 - world.x) * 0.08;
  else if (a === 'boot')  world.x += (26 - world.x) * 0.08;
  else if (a === 'work')  world.x += Math.sin(t*1.7) * 0.7;
  world.x = Math.max(8, Math.min(140, world.x));

  var ax = Math.round(world.x), ay = Math.round(50 + bob);
  g.fillStyle = world.smoke > 0 ? P.bad : P.ink;
  g.fillRect(ax, ay, 6, 9);                       // body
  g.fillRect(ax+1, ay-5, 4, 4);                   // head
  if (a === 'build'){                             // an arm that works
    var sw = Math.sin(t*14) > 0 ? -2 : 1;
    g.fillRect(ax+6, ay+1+sw, 3, 2);
    g.fillStyle = P.trim; g.fillRect(64,58,14,6);  // bench
  }
  if (a === 'pull' && world.crates){              // carrying
    g.fillStyle = P.trim; g.fillRect(ax+6, ay, 6, 6);
  }

  // smoke, when it broke
  if (world.smoke > 0){
    for (var s=0;s<4;s++){
      var sy = ay - 8 - ((t*14 + s*5) % 22);
      g.fillStyle = 'rgba(209,97,93,' + (0.5 - s*0.1).toFixed(2) + ')';
      g.fillRect(ax + 2 + Math.round(Math.sin(t*3+s)*2), Math.round(sy), 3, 3);
    }
  }

  // who else is here, standing along the near wall
  var others = Math.max(0, world.watching - 1);
  for (var w=0; w<Math.min(others,8); w++){
    g.fillStyle = 'rgba(233,239,235,.35)';
    g.fillRect(6 + w*7, 76, 4, 7);
    g.fillRect(7 + w*7, 72, 2, 3);
  }
}

function frame(now){
  nextAction(now);
  if (world.opening) world.opening += 0.02;
  paint(now);
  if (world.opening >= 1 && !world.opened){
    world.opened = true;
    // The reload happens behind the light, so the swap to the real app is not a
    // flash of white — it is the door finishing its swing.
    setTimeout(function(){ location.reload(); }, 260);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- the feed ----
function say(msg){ hintEl.innerHTML = msg; }
function here(n){
  world.watching = n;
  hereEl.textContent = n > 1 ? (n + ' watching') : 'just you';
}

var es = new EventSource('/_room/events');
es.onmessage = function(ev){
  var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
  if (m.t === 'hello'){ here(m.watching); return; }
  if (m.t === 'watching'){ here(m.n); return; }
  if (m.t === 'steps'){ enqueue(m.steps); say(''); return; }
  if (m.t === 'quiet'){
    world.quiet = true; world.act = 'idle';
    // Said out loud rather than animated over. The long silence at the start of a
    // deploy is the job's own cold start, and pretending otherwise is the one
    // thing this page is not allowed to do.
    say('Waiting — nothing has happened for a few seconds.');
    return;
  }
  if (m.t === 'broke'){
    world.smoke = 1; world.act = 'idle';
    if (OWNER) say('This build stopped.' + (m.reason ? ' ' + escapeText(m.reason) : '') +
                   '<br>Ship it again from the folder: <code>supersonic deploy</code>');
    else say('This app is still being built. Nothing to see yet.');
    return;
  }
  if (m.t === 'open'){ world.opening = 0.02; say(''); return; }
};
es.onerror = function(){
  // The stream can die without the build dying. Reconnecting is the browser's
  // job; the room keeps drawing what it already knows.
  say('');
};

function escapeText(s){
  return String(s).replace(/[&<>"']/g, function(ch){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];
  }).slice(0,200);
}
`;
}
