import { escapeHtml } from "./pages";

/**
 * Where the film comes from.
 *
 * The picture is built and served by the control plane (apps/web, `npm run
 * film` → public/film/ship-it.js) because that is where its source lives and
 * where it is already used, on the dashboard's own deploy screen. This service
 * cannot build it: `gcloud run deploy --source services/proxy` sends this
 * directory and nothing else, so a copy here would be a fork of 1,500 lines of
 * camera moves that nobody would ever reconcile.
 *
 * A cross-origin `<script src>` needs no permission to run, and the film is
 * mounted only if it actually arrives — see `filmBoot` below. If it does not,
 * the room is exactly what it was.
 */
const FILM_ORIGIN = process.env.FILM_ORIGIN ?? "https://app.thebay.cloud";

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
  // A guest gets a different PAGE, not the same page with things switched off.
  //
  // It used to be one page and a flag: `OWNER` suppressed the build line and the
  // failure text, and everything else — the film, the room, the stage bar, the
  // count of stages and which one had broken — was drawn for whoever had the
  // link. That is a picture of somebody's build shown to somebody who was sent
  // a URL, and the words were never the whole of what it disclosed.
  //
  // Two functions rather than one branchy one, because the property worth having
  // is structural: there is no film, no feed and no script on the guest page for
  // a future edit to accidentally re-enable. The stream is refused to guests as
  // well (see serveRoomEvents) — the page is the second lock, not the only one.
  if (!owner) return pageGuestRoom(slug);
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(slug)} — building</title>
<style>
  :root{--bg:#0e1512;--ink:#e9efeb;--dim:#6d7d74;--go:#2ea86a;--bad:#d1615d}
  *{box-sizing:border-box}
  /* The whole window is the picture.
     This page stands at the app's own address with nothing else on it, so a
     720px card floating in a dark field was spending most of the screen on
     nothing. 100dvh rather than 100vh: on a phone the toolbars come and go
     and vh is the tallest of those states, which puts the stage bar under the
     browser's own chrome for the first half of the deploy. */
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);overflow:hidden;
       font:14px/1.5 ui-monospace,"SF Mono",Menlo,monospace}
  #wrap{position:fixed;inset:0;height:100dvh;background:#0a100e}

  /* The pixel room, which is what stands here until the film lands and what
     stays if it never does. "contain", not "cover": it is drawn at 160x90 and
     cropping hand-placed pixel art loses the door or the shelf. */
  #stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
  #stage canvas{width:100%;height:100%;display:block;object-fit:contain;image-rendering:pixelated}

  /* the film, when it is the picture. Its own chrome, kept to what says
     something: which shot this is, which stage the deploy is on, and the log. */
  #film{position:absolute;inset:0;overflow:hidden;background:#0a100e}
  /* The holder the film appends its canvas into has to have a height of its
     own. It never needed one before: the canvas sized itself with
     aspect-ratio, which resolves against an auto-height parent perfectly well.
     "height:100%" does not — it resolves to auto, the canvas falls back to its
     intrinsic buffer ratio, and the picture sits in a band across the top of
     the window with dead space under it. Caught in a headless render at
     900x1200; it is invisible at 16:9, which is where it would have been
     looked at. */
  #film .fcanvas{position:absolute;inset:0}
  /* object-fit matters here and is not decoration.
     The film sizes its own drawing buffer to this box, so with the film this
     page was written against the fit is an identity. But the film is served by
     the control plane and this service deploys in a SEPARATE workflow off the
     same push — for a few minutes either one can be the newer. An older film
     still frames its buffer at 2.40:1, and stretched to a 16:9 window that is
     the whole picture squashed. Contained, it letterboxes: right picture, black
     edges, gone by the time the other deploy lands. */
  #film canvas{display:block;width:100%;height:100%;object-fit:contain}
  .fslate{position:absolute;left:22px;top:18px;font-size:10px;letter-spacing:.18em;
          color:rgba(255,255,255,.86);text-shadow:0 1px 2px rgba(0,0,0,.5);pointer-events:none}
  .fstagebar{position:absolute;left:22px;bottom:18px;right:22px;display:flex;align-items:baseline;gap:9px;
             font-size:11px;color:rgba(255,255,255,.62);pointer-events:none;
             text-shadow:0 1px 3px rgba(0,0,0,.6);opacity:.62;transition:opacity .3s ease}
  .fstagebar b{font-size:13px;color:#fff}
  .fstagebar .no{font-variant-numeric:tabular-nums;letter-spacing:.14em}
  .fstagebar .note{opacity:0;transition:opacity .3s ease}
  .fstagebar.held{opacity:1}
  .fstagebar.held .note{opacity:.8}
  .fvig{position:absolute;inset:0;pointer-events:none;
        background:radial-gradient(120% 90% at 50% 50%,transparent 55%,rgba(0,0,0,.28) 100%)}
  .fbang{position:absolute;inset:0;pointer-events:none;opacity:0;
         background:radial-gradient(60% 60% at 50% 55%,rgba(255,236,206,.95),rgba(226,84,32,.75) 45%,rgba(120,20,8,.35) 100%)}
  .fgrade{position:absolute;inset:0;pointer-events:none;mix-blend-mode:soft-light;opacity:0}

  /* The build's own words, over the picture.
     Same shape as the bench the film is tuned on (apps/web/scripts/film-studio):
     a time gutter, a glyph, the line. Six of them, because that is what fits
     without the log becoming the page. Rendered here rather than handed to the
     film's own log box: this has to read the same when there is no film at all,
     and the film only writes into elements inside its own mount. */
  /* The log and anything the page has to SAY share one column, stacked from the
     bottom. They were both anchored to bottom:52px and drew over each other the
     first time the build went quiet. */
  #tell{position:absolute;left:22px;bottom:52px;width:min(62ch,52vw);
        display:flex;flex-direction:column;gap:9px;pointer-events:none}
  #log{display:flex;flex-direction:column;font-size:11px;line-height:1.65;
       color:rgba(233,239,235,.60);
       text-shadow:0 1px 3px rgba(0,0,0,.75)}
  #log>div{display:flex;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #log .t{color:rgba(233,239,235,.34);font-variant-numeric:tabular-nums}
  #log .k{width:1em;flex:none}
  #log .m{overflow:hidden;text-overflow:ellipsis}
  #log .g{color:var(--go)} #log .e{color:var(--bad)} #log .a{color:#7FA8D8}

  /* the corners: who this is, who else is here, and anything the page has to
     say in words. */
  /* Top RIGHT, not spread across the top: the film puts its slate in the top
     left corner, and a name spread to the left edge printed over it. */
  .bar{position:absolute;right:22px;top:18px;display:flex;gap:12px;
       align-items:baseline;justify-content:flex-end;
       color:var(--dim);font-size:12px;pointer-events:none;
       text-shadow:0 1px 3px rgba(0,0,0,.75)}
  #name{color:var(--ink)}
  #here{white-space:nowrap}
  #hint{color:var(--dim);font-size:12px;line-height:1.6;
        text-shadow:0 1px 3px rgba(0,0,0,.75)}
  #hint:empty{display:none}
  code{background:rgba(29,38,33,.85);padding:.1rem .35rem;border-radius:.25rem;color:var(--ink)}
</style>
<div id="wrap">
  <div id="stage"><canvas id="c" width="160" height="90"></canvas></div>
  <!-- The film. Empty and hidden until the script lands and WebGL says yes; the
       room above is what stands there in the meantime and what stays there if it
       never does. -->
  <div id="film" hidden>
    <div class="fcanvas" data-el="cv" role="img"
         aria-label="An animated cutaway of this build: a ship built in a dry dock, launched, and sailing under the Golden Gate as the app goes live."></div>
    <div class="fslate" data-el="slate"></div>
    <div class="fbang" data-el="bang"></div>
    <div class="fgrade" data-el="grade"></div>
    <div class="fvig"></div>
    <div class="fstagebar" data-el="stagebar">
      <span class="no" data-el="stageNo"></span>
      <b data-el="stageName"></b>
      <span class="note" data-el="stageNote"></span>
    </div>
  </div>
  <div class="bar"><span id="name">${escapeHtml(slug)}</span><span id="here"></span></div>
  <div id="tell">
    <div id="hint"></div>
    <div id="log"></div>
  </div>
</div>
<script src="${FILM_ORIGIN}/film/ship-it.js" async
        onload="window.__filmArrived&&window.__filmArrived()"
        onerror="window.__filmGone&&window.__filmGone()"></script>
<script>
${clientScript(slug)}
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

function clientScript(slug: string): string {
  const SLUG = jsonForScript(slug);
  return String.raw`
var SLUG = ${SLUG};
var c = document.getElementById('c'), g = c.getContext('2d');
var logEl = document.getElementById('log'), hereEl = document.getElementById('here'), hintEl = document.getElementById('hint');

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
  db: 0,                            // a provisioned database, once there is one
  helper: 0,                        // the repair agent, once it has taken over
  smoke: 0, quiet: false, opening: 0, opened: false,
  watching: 1
};

// ---- the film ----
// A second picture of the same build, cut the other way round: the room walks
// on every LINE, the film cuts on every STAGE and then holds — camera still
// moving — until the deploy says otherwise. Whichever one is on screen, nothing
// here invents motion; see the rule at the top of this file.
var film = null, filmState = null, filmSeen = { scenario:'', rail:'', index:-1 };
var filmDead = false, filmBuf = [];

/**
 * Fold one event into what the film should be showing.
 *
 * Buffered when the script has not landed yet, and that is the point: the tag
 * is 'async', a room is often opened mid-build, and the first stages routinely
 * arrive before 600 KB of picture does. Dropping them would leave the film
 * holding on the first shot of a build that is already plating — a picture that
 * is wrong rather than late, which is the one thing this page may not be.
 */
function filmFold(ev){
  var api = window.SupersonicFilm;
  if (!api){
    filmBuf.push(ev);
    if (filmBuf.length > 300) filmBuf.shift();
    return;
  }
  for (var i=0;i<filmBuf.length;i++) filmState = api.drive(filmState || api.START, filmBuf[i]);
  filmBuf = [];
  filmState = api.drive(filmState || api.START, ev);
}

function filmReady(){
  if (film || filmDead) return film;
  var api = window.SupersonicFilm;
  if (!api) return null;
  // Reasons not to: no WebGL, a phone in portrait, or somebody who has asked
  // their machine to stop moving things. Each of those keeps the room, which is
  // 10 KB and draws in any browser that has a canvas.
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { filmDead = true; return null; }
    if (innerWidth < 560) { filmDead = true; return null; }
    var probe = document.createElement('canvas');
    if (!probe.getContext('webgl2') && !probe.getContext('webgl')) { filmDead = true; return null; }
  } catch(e){ filmDead = true; return null; }

  // Mounted on the cut the build is ALREADY on. A room opened after a build has
  // failed wants the film with the break in it, not a rebuild of the container
  // cut a moment later.
  var scenario = (filmState && filmState.scenario) || 'container';
  var host = document.getElementById('film');
  film = api.mountFilm(host, { scenario: scenario });
  if (!film || !film.stages().length) { film = null; filmDead = true; return null; }
  filmSeen = { scenario: scenario, rail:'', index:-1 };
  film.identity({ app: SLUG, url: location.host, release:'', node:'' });
  // The room steps aside rather than being removed: if the film ever throws, a
  // reload brings the room back with the same feed behind it.
  document.getElementById('stage').hidden = true;
  host.hidden = false;
  return film;
}

/** One stage boundary: folded in, and shown if there is anything to show it on. */
function filmStage(step){
  filmFold({ type:'stage', stage: step.stage, phase: step.phase, outcome: step.outcome });
  if (filmReady()) filmApply();
}

function filmApply(){
  var api = window.SupersonicFilm;
  if (!film || !filmState || !api) return;
  if (filmState.scenario !== filmSeen.scenario){
    film.scenario(filmState.scenario);
    filmSeen = { scenario: filmState.scenario, rail:'', index:-1 };
  }
  if (filmState.rail && filmState.rail !== filmSeen.rail){
    filmSeen.rail = filmState.rail;
    var i = api.railIndex(film.stages(), filmState.rail, filmSeen.index + 1);
    if (i >= 0){ film.setStage(i); filmSeen.index = i; }
  }
}

function enqueue(steps){
  for (var i=0;i<steps.length;i++) {
    // Stage boundaries are the film's business and not the room's: the room is
    // drawn from lines, one movement per line, and a stage is not a line.
    if (steps[i].kind === 'stage') { filmStage(steps[i]); continue; }
    queue.push(steps[i]);
  }
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
  if (step.kind === 'prepare')   world.boxes  = Math.min(world.boxes + 1, 14);
  if (step.kind === 'unpack')    world.crates = Math.min(world.crates + 1, 6);
  if (step.kind === 'pull')      world.crates = Math.min(world.crates + 1, 6);
  if (step.kind === 'provision') world.db = 1;
  if (step.kind === 'boot')      world.lamp = Math.min(world.lamp + 0.12, 1);
  if (step.kind === 'broke')     world.smoke = 1;
  // The repair agent arriving is the one thing that clears the smoke: it is the
  // moment the room stops being a failure and starts being a rescue.
  if (step.kind === 'repair')  { world.helper = 1; world.smoke = 0; }
  if (step.text) logLine(step);
}

// ---- the log ----
// Written when the movement is PERFORMED, not when the line arrives, so the
// words and the picture are describing the same moment. A room opened late
// drains its backlog at a pace (above), and a log that ran ahead of that would
// be narrating work the agent on screen has not got to yet.
var lines = [];

/** Which glyph a line gets. */
function glyphOf(step){
  if (step.kind === 'broke') return 'e';
  if (step.kind === 'repair') return 'a';
  // The same test the deploy screen uses (apps/web/app/new/page.tsx), on the
  // same lines, so one build does not get two different sets of ticks
  // depending on which page you happened to watch it from.
  if (/^(Detected|Provision|Live at|Injecting|Agent fixed)/.test(step.text || '')) return 'g';
  return '';
}

function logLine(step){
  lines.push({ t: typeof step.t === 'number' ? step.t : 0, k: glyphOf(step), m: step.text });
  // Six, and the rest dropped rather than scrolled: this sits over the picture
  // with nothing to scroll it, and a build emits hundreds of lines.
  if (lines.length > 6) lines.shift();
  drawLog();
}

function drawLog(){
  var out = '';
  for (var i=0;i<lines.length;i++){
    var l = lines[i];
    var glyph = l.k === 'g' ? '✓' : l.k === 'e' ? '✕' : l.k === 'a' ? '◆' : '·';
    var secs = String(Math.max(0, Math.floor(l.t)));
    out += '<div class="' + l.k + '"><span class="t">' + secs + 's</span>' +
           '<span class="k">' + glyph + '</span>' +
           '<span class="m">' + escapeText(l.m) + '</span></div>';
  }
  logEl.innerHTML = out;
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

  // a provisioned database, standing where it was put
  if (world.db){
    g.fillStyle = P.trim; g.fillRect(74,44,12,20);
    g.fillStyle = P.go;   g.fillRect(76,46,8,3);
    g.fillStyle = P.dim;  g.fillRect(76,52,8,2); g.fillRect(76,57,8,2);
  }

  // the agent. Each kind of line sends them somewhere: the shelf for
  // dependencies, the doorway for a release, the lamp when the app comes up.
  var a = world.act, bob = Math.sin(t*6) * (a==='idle'||world.quiet ? 0.6 : 1.4);
  if (a === 'prepare')        world.x += (118 - world.x) * 0.08;
  else if (a === 'unpack')    world.x += (18 - world.x) * 0.08;
  else if (a === 'pull')      world.x += (12 - world.x) * 0.08;
  else if (a === 'build')     world.x += (68 - world.x) * 0.08;
  else if (a === 'provision') world.x += (80 - world.x) * 0.08;
  else if (a === 'release')   world.x += (120 - world.x) * 0.08;
  else if (a === 'boot')      world.x += (26 - world.x) * 0.08;
  else if (a === 'detect')    world.x += Math.sin(t*2.3) * 1.1;
  else if (a === 'work')      world.x += Math.sin(t*1.7) * 0.7;
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
  if ((a === 'pull' || a === 'unpack') && world.crates){   // carrying something in
    g.fillStyle = P.trim; g.fillRect(ax+6, ay, 6, 6);
  }

  // The repair agent. A second figure, in the platform's own green rather than
  // white, so it reads as somebody else having turned up — which is exactly what
  // has happened. Its lines are the second most common opener in a deploy.
  if (world.helper){
    var hx = Math.round(world.x) - 14 + Math.round(Math.sin(t*2)*2);
    g.fillStyle = P.go;
    g.fillRect(hx, ay + 1, 6, 8);
    g.fillRect(hx + 1, ay - 4, 4, 4);
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

function arrive(){
  if (world.opened) return;
  world.opened = true;
  // The reload happens behind the light, so the swap to the real app is not a
  // flash of white — it is the door finishing its swing.
  setTimeout(function(){ location.reload(); }, 260);
}

function frame(now){
  nextAction(now);
  if (world.opening) world.opening += 0.02;
  paint(now);
  if (world.opening >= 1) arrive();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// A hidden tab does not get animation frames at all, so everything above stops:
// the door never finishes swinging and the reload that rides on it never fires.
// Someone who sent themselves the link and switched away would come back to a
// room frozen mid-open, with their app live behind it the whole time.
//
// Nobody is watching a hidden tab, so there is no animation to protect. If the
// app opened while we were away, just be the app.
document.addEventListener('visibilitychange', function(){
  if (document.visibilityState === 'visible' && world.opening) arrive();
});

// ---- the feed ----
function say(msg){ hintEl.innerHTML = msg; }
function here(n){
  world.watching = n;
  hereEl.textContent = n > 1 ? (n + ' watching') : 'just you';
}

// The film script is 'async' and may land either side of this one. Both orders
// are handled and neither polls: the tag calls these when it resolves, and the
// line below covers the case where it had already resolved before this script
// ran. Nothing is lost by arriving late — the stages are folded into filmState
// whether or not a picture exists yet.
window.__filmArrived = function(){
  // Flush first: the cut to mount depends on what the build has already done.
  filmFold({ type:'noop' });
  if (filmReady()) filmApply();
};
window.__filmGone = function(){ filmDead = true; };
if (window.SupersonicFilm) window.__filmArrived();

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
    say('Waiting — the build has not said anything for a while.');
    return;
  }
  if (m.t === 'broke'){
    world.smoke = 1; world.act = 'idle';
    // No "try again" button here, and it is not an omission. A deploy's request
    // — the app's secrets included — lives in one deploy_runs row, and finishRun
    // DELETES that row and the encrypted source the moment the build ends, so a
    // secret is only readable for the length of one build. Verified against
    // production: zero rows, including for every failed app. Retrying from the
    // server would mean keeping somebody's secrets around on the chance they
    // press a button. The command below re-sends them from the machine that owns
    // them, which is the whole design.
    say('This build stopped.' + (m.reason ? ' ' + escapeText(m.reason) : '') +
        '<br>Ship it again from the folder: <code>supersonic deploy</code>' +
        '<br>The full log: <code>supersonic logs ' + escapeText(SLUG) + '</code>');
    return;
  }
  if (m.t === 'open'){
    world.opening = 0.02; say('');
    // The app answered, which is the film's last shot — the sun coming up
    // through the span. It gets a moment before arrive() replaces this page
    // with the app itself.
    filmFold({ type:'done', slug: SLUG, url: location.origin });
    if (filmReady()) filmApply();
    return;
  }
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

/**
 * What someone who was sent the link sees.
 *
 * Not a smaller room — no room at all. A deploy in progress is the owner's
 * business: which stages there are, how far it has got, whether it broke and
 * how many times it has been rebuilt are all facts about somebody's work, and
 * a shared URL is not consent to any of them. So this page says the one true
 * thing a stranger is entitled to, which is that the address is not ready yet.
 *
 * THE SPINNER IS ALLOWED TO BE A SPINNER. The room's rule — every movement
 * stands for one real line — exists because a picture that animates over
 * silence is a preloader pretending to be information. This makes no such
 * claim: it turns at a constant rate, it is obviously a wait indicator, and it
 * is the honest shape for a page that genuinely knows nothing.
 *
 * No script at all. The reload is a meta refresh, so the page holds no feed, no
 * film and nothing to inspect; when the app starts answering, the edge stops
 * serving this page and serves the app.
 */
function pageGuestRoom(slug: string): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>${escapeHtml(slug)} — deploying</title>
<style>
  :root{--bg:#0e1512;--ink:#e9efeb;--dim:#6d7d74}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);
       font:14px/1.5 ui-monospace,"SF Mono",Menlo,monospace;
       display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:20px}
  .sp{width:26px;height:26px;border-radius:50%;
      border:2px solid rgba(233,239,235,.16);border-top-color:var(--ink);
      animation:spin 900ms linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .msg{color:var(--dim);font-size:13px;letter-spacing:.02em}
  .who{color:var(--ink)}
  /* Someone who has asked their machine to stop moving things gets a dot that
     does not turn. The page still says the same sentence, which was always the
     part carrying the information. */
  @media (prefers-reduced-motion:reduce){
    .sp{animation:none;border-top-color:rgba(233,239,235,.16);background:rgba(233,239,235,.18)}
  }
</style>
<div class="sp" role="status" aria-label="Deploying"></div>
<div class="msg"><span class="who">${escapeHtml(slug)}</span> — deploying in progress</div>`;
}
