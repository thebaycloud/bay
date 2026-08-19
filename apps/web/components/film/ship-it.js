import * as THREE from "three";

/**
 * SHIP IT — the deploy as a cartoon, cut like a film.
 *
 * Ported out of the motion study (artifact ff21b077) with the picture untouched
 * and the harness replaced. Three things changed, and only these three:
 *
 *  1. three.js is imported rather than inlined, so the 800KB of it is the
 *     bundler's problem and lands in a chunk this component loads on demand.
 *  2. every DOM lookup is scoped to the element the caller mounts into, by
 *     `data-el` rather than by id, and a missing one returns a detached div.
 *     The study rendered a full player — scrubber, speed, scenario picker — and
 *     a product surface renders almost none of it. A film that throws because
 *     nobody drew a Pause button would be a silly way to fail a deploy screen.
 *  3. the player's outside handle is returned instead of being hung on
 *     `window`, and it now has a `destroy` — React mounts this twice in
 *     development and a leaked WebGL context is a real leak.
 *
 * WHAT DRIVES IT. The study ran on a clock: p50 durations, straight through.
 * This runs on the deploy. `setStage` plays into a stage and then CREEPS
 * through it — approaching the end and never arriving, because the last of
 * every stage belongs to the deploy and not to us. So the picture waits
 * exactly as long as the deploy waits. The rails the film knows are the stage
 * names lib/stage-names.ts declares, deliberately: see lib/deploy-film.ts for
 * the mapping, which is one table and no cleverness.
 *
 * TWO CLOCKS. This is the thing to understand before changing anything here.
 * STORY time is where the ship is in her own construction, and it is paced by
 * the deploy (`creep`, in the player at the bottom). WALL time is the clock on
 * the wall, and it never stops. Everything that is PROGRESSING hangs off the
 * story clock; everything that is merely ALIVE — the water, the welders, the
 * gantry, the traffic, the ferries, the lamps, and the camera — hangs off the
 * wall clock. Wiring a moving thing to the story clock is how the first cut of
 * this ended up as four minutes of a photograph whenever a build was slow.
 */

/**
 * Build the film inside `root` and return the handle a deploy drives it with.
 *
 * `root` must contain `[data-el="cv"]`, a canvas. Everything else is optional
 * and simply is not drawn if it is not there.
 */
export function mountFilm(root, opts = {}) {
// (module code is strict already; the study said so out loud because it was a <script>)
const controls = opts.controls === true;
const abort = new AbortController();
const sig = { signal: abort.signal };
/** Elements the film writes to but this mount does not draw. A detached div
    takes a textContent and a class and shows nobody, which is what we want. */
const stubs = new Map();
const el = (id) => root.querySelector('[data-el="' + id + '"]');
const stub = (id) => { let s = stubs.get(id); if (!s) { s = document.createElement("div"); stubs.set(id, s); } return s; };

const cl=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const seg=(t,a,b)=>b<=a?(t>=b?1:0):cl((t-a)/(b-a));
const eo=x=>1-Math.pow(1-x,3);
const ei=x=>x*x*x;
const eio=x=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const lerp=(a,b,k)=>a+(b-a)*k;
const $=id=>el(id)||stub(id);
const esc=s=>s.replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
const V3=(x,y,z)=>new THREE.Vector3(x,y,z);
/* one deterministic stream, so every reload is the same film */
let _s=1; const rs=s=>{_s=s>>>0;}; const rnd=()=>{_s=(_s*1664525+1013904223)>>>0;return _s/4294967296;};
const pick=a=>a[(rnd()*a.length)|0];

/* ---------- two clocks ----------
   STORY TIME (`t`, and `NOW` inside a frame) is where the ship is in her own
   construction. It is paced by the deploy: see `paceRate`. It stops when the
   deploy stops.

   WALL TIME (`WALL`, and `TT` inside a frame) is the clock on the wall. It
   never stops, and everything that is alive rather than progressing hangs off
   it: the water, the traffic, the birds, the welders, the ferries, the lamps,
   and the camera. That split is the whole answer to the film's worst habit —
   a stage that takes four minutes used to be four minutes of a still frame,
   because every moving thing in the picture was wired to the story clock and
   the story clock had nowhere left to go. */
let WALL=0, DTW=1/60;
/** Seconds of wall time since the film last cut. Drives the camera. */
let SHOTW=0;
/** Set for one frame after a seek, so smoothed values jump instead of easing. */
let SNAP=true;

/* ---------- the timeline ---------- */
const L=(o,k,m)=>({o,k,m});
const SCENARIOS={
  container:{
    lane:"container lane · warm worker", app:"storefront", url:"storefront.supersonic.cv",
    node:"n-04", release:"41", cargo:[0,0,1,0,1,0], crates:18,
    beats:[
      {id:"accept",rail:"run-record",dur:0.6,logs:[L(0,"a","supersonic deploy · run 8f3c21b")]},
      {id:"dispatch",rail:"dispatch",dur:0.9,logs:[L(.2,"","warm worker accepted — 202")]},
      {id:"clone",rail:"clone",dur:4.5,logs:[L(0,"","Pulling github.com/acme/storefront"),L(3.4,"g","1 248 files · 18.4 MB")]},
      {id:"detect",rail:"detect",dur:1.6,logs:[L(0,"","Detecting stack…"),L(1,"g","Detected Next.js · TypeScript (94%)")]},
      {id:"plan",rail:"plan",dur:9,logs:[L(0,"a","Planning the deploy — the agent reads the repo…"),L(3.5,"a","agent · read app/layout.tsx"),L(6,"a","agent · read prisma/schema.prisma"),L(8.2,"g","Plan ready: Next.js standalone on node 22")]},
      {id:"render",rail:"render",dur:1.2,logs:[L(0,"","Building an image on node 22"),L(.6,"","Base pinned to node:22-slim @ sha256:9f2ad1c…")]},
      {id:"build",rail:"build",dur:33.3,logs:[L(1,"","npm ci — 412 packages"),L(13,"","next build — 24 routes"),L(23,"g","Provisioned Postgres database db_storefront"),L(31,"g","Compiled successfully")]},
      {id:"upload",rail:"upload",dur:8,logs:[L(0,"","Uploading…"),L(6,"g","5 layers · 2 cached · 148 MB")]},
      {id:"release",rail:"release",dur:1.2,logs:[L(.4,"g","Published release 41")]},
      {id:"flood",rail:"release",dur:6,logs:[L(.3,"","Flooding the dock — the release is sealed")]},
      {id:"place",rail:"fleet",dur:87.7,logs:[L(0,"","Placing on node n-04 · us-central1-a"),L(5,"","fleet-pull · the node is pulling the image"),L(64,"g","fleet-pull — 62.1s"),L(68,"","fleet-boot · sandbox starting"),L(80,"g","fleet-boot — 6.2s")]},
      {id:"verify",rail:"verify",dur:5,logs:[L(0,"","Checking the build…"),L(3.6,"g","GET / → 200 in 84 ms")]},
      {id:"live",rail:"done",dur:11,logs:[L(.5,"","Private by default — anyone opening this link has to sign in."),L(1.6,"g","Live at storefront.supersonic.cv")]}
    ]},
  repair:{
    lane:"container lane · the build fails", app:"storefront", url:"storefront.supersonic.cv",
    node:"n-04", release:"42", cargo:[0,0,1,0,1,0], crates:18, fail:{beat:"build",at:.62},
    beats:[
      {id:"accept",rail:"run-record",dur:0.6,logs:[L(0,"a","supersonic deploy · run 4d90ff2")]},
      {id:"dispatch",rail:"dispatch",dur:0.9,logs:[L(.2,"","warm worker accepted — 202")]},
      {id:"clone",rail:"clone",dur:4.5,logs:[L(0,"","Pulling github.com/acme/storefront"),L(3.4,"g","1 251 files · 18.5 MB")]},
      {id:"detect",rail:"detect",dur:1.6,logs:[L(0,"","Detecting stack…"),L(1,"g","Detected Next.js · TypeScript (94%)")]},
      {id:"plan",rail:"plan",dur:7,logs:[L(0,"a","Planning the deploy — the agent reads the repo…"),L(6,"g","Plan ready: Next.js standalone on node 22")]},
      {id:"render",rail:"render",dur:1.2,logs:[L(0,"","Building an image on node 22")]},
      {id:"build",rail:"build",dur:29,logs:[L(1,"","npm ci — 412 packages"),L(13,"","next build — 24 routes"),L(18,"e","next build failed — Type error: Property 'sessin' does not exist"),L(19,"e","the build produced no image")]},
      {id:"repair",rail:"repair-agent",dur:46,logs:[L(.5,"a","Repair agent taking over"),L(6,"a","agent · read app/api/cart/route.ts"),L(16,"a","agent · read lib/auth.ts"),L(26,"a","agent · patched app/api/cart/route.ts"),L(27.4,"a","  - const { sessin } = await auth()"),L(28.4,"a","  + const { session } = await auth()"),L(40,"a","agent · redeploying (attempt 1)…")]},
      {id:"rebuild",rail:"build",dur:31,logs:[L(1,"","npm ci — 412 packages (cached)"),L(12,"","next build — 24 routes"),L(28,"g","Compiled successfully"),L(29.5,"g","Agent fixed it — 1 file changed")]},
      {id:"upload",rail:"upload",dur:8,logs:[L(0,"","Uploading…"),L(6,"g","5 layers · 2 cached · 151 MB")]},
      {id:"release",rail:"release",dur:1.2,logs:[L(.4,"g","Published release 42")]},
      {id:"flood",rail:"release",dur:6,logs:[]},
      {id:"place",rail:"fleet",dur:87.7,logs:[L(0,"","Placing on node n-04 · us-central1-a"),L(64,"g","fleet-pull — 61.4s"),L(80,"g","fleet-boot — 5.9s")]},
      {id:"verify",rail:"verify",dur:5,logs:[L(0,"","Checking the build…"),L(3.6,"g","GET / → 200 in 91 ms")]},
      {id:"live",rail:"done",dur:11,logs:[L(1.6,"g","Live at storefront.supersonic.cv")]}
    ]},
  static:{
    lane:"static lane · no image, no node", app:"portfolio", url:"portfolio.supersonic.cv",
    node:"edge", release:"7", cargo:[0,1], crates:10,
    beats:[
      {id:"accept",rail:"run-record",dur:0.6,logs:[L(0,"a","supersonic deploy · run 2b71c04")]},
      {id:"dispatch",rail:"dispatch",dur:0.9,logs:[L(.2,"","warm worker accepted — 202")]},
      {id:"clone",rail:"clone",dur:3.2,logs:[L(0,"","Pulling github.com/acme/portfolio"),L(2.4,"g","214 files · 3.1 MB")]},
      {id:"detect",rail:"detect",dur:1.4,logs:[L(0,"","Detecting stack…"),L(.9,"g","Detected Vite · TypeScript (97%)")]},
      {id:"plan",rail:"plan",dur:5,logs:[L(0,"a","Planning the deploy — the agent reads the repo…"),L(4,"g","Vite builds to a directory — publishing it without a container")]},
      {id:"render",rail:"render",dur:0.6,logs:[]},
      {id:"build",rail:"build",dur:21,logs:[L(1,"","npm ci — 168 packages"),L(9,"","vite build — 42 modules"),L(19,"g","dist/ · 1.9 MB")]},
      {id:"upload",rail:"upload",dur:6,logs:[L(0,"","Uploading…"),L(4.4,"g","bundle uploaded · 1.9 MB")]},
      {id:"release",rail:"release",dur:1,logs:[L(.3,"g","Published release 7")]},
      {id:"flood",rail:"release",dur:5,logs:[]},
      {id:"place",rail:"deploy",dur:12,logs:[L(0,"","Serving it from the edge — no node, no image to pull")]},
      {id:"verify",rail:"verify",dur:4,logs:[L(0,"","Checking the build…"),L(2.8,"g","GET / → 200 in 31 ms")]},
      {id:"live",rail:"done",dur:11,logs:[L(1,"g","Live at portfolio.supersonic.cv")]}
    ]}
};
let SC,AT,TOTAL,FAIL_T=Infinity,LOGS=[],NOW=0;
/* What the film says about the app it is showing. The study had a fictional
   storefront; a real deploy has its own name, address and lane, and the
   endcard is a promise about a URL a person is about to open. */
let IDENT={};
/** Which cut is loaded, so `identity` can rebuild it without being told. */
let KEY="container";
function compile(key){
  KEY=key;SC={...SCENARIOS[key],...IDENT};AT={};LOGS=[];let t=0;
  for(const b of SC.beats){
    AT[b.id]={s:t,e:t+b.dur,d:b.dur,rail:b.rail};
    for(const l of (b.logs||[]))LOGS.push({t:t+l.o,k:l.k,m:l.m});
    t+=b.dur;
  }
  LOGS.sort((a,b)=>a.t-b.t);TOTAL=t;
  FAIL_T=SC.fail?AT[SC.fail.beat].s+AT[SC.fail.beat].d*SC.fail.at:Infinity;
}
const S=id=>AT[id]?AT[id].s:0, E=id=>AT[id]?AT[id].e:0;
/* ---------- stages ----------
   The rails, grouped: consecutive beats on the same rail are one stage, which
   is exactly the granularity a deploy reports at. In stage mode the film runs
   to the end of the current stage and then holds — the camera keeps moving,
   the water keeps moving, the story does not — until something advances it.
   That something is the Next button here, and setStage() from a real deploy. */
const STAGE_NAME={
  "run-record":["Run recorded","the deploy exists as a record before anything is done to it"],
  "dispatch":["Dispatched","a warm worker takes the job"],
  "clone":["Source pulled","the repository comes off the truck and onto the quay"],
  "detect":["Stack detected","what this is, and what it will need"],
  "plan":["Plan ready","the agent reads the repo and decides how to build it"],
  "render":["Keel laid","the image is planned: base, layers, runtime"],
  "build":["Built","the hull goes up plate by plate"],
  "repair-agent":["Repaired","the agent finds the break, patches it, and welds her shut"],
  "upload":["Layers uploaded","one bay of containers per layer of the image"],
  "release":["Release sealed","the number goes on the funnel, and the dock floods"],
  "fleet":["Placed on the fleet","the node pulls the image and boots the sandbox"],
  "deploy":["Served from the edge","no node, no image to pull"],
  "verify":["Verified","a request goes in and two hundred comes back"],
  "done":["Live","she is out, and the address answers"]
};
let STAGES=[];
function buildStages(){
  STAGES=[];
  for(const b of SC.beats){
    const last=STAGES[STAGES.length-1];
    if(last&&last.rail===b.rail){ last.e=AT[b.id].e; last.ids.push(b.id); }
    else STAGES.push({rail:b.rail,s:AT[b.id].s,e:AT[b.id].e,ids:[b.id],
                      name:(STAGE_NAME[b.rail]||[b.rail,""])[0],
                      note:(STAGE_NAME[b.rail]||[b.rail,""])[1]});
  }
  /* a failing run does build twice: say so, rather than showing "Built" twice */
  const builds=STAGES.filter(s=>s.rail==="build");
  if(builds.length>1){ builds[0].name="Build failed"; builds[0].note="the type error is real, and the image never gets made";
                       builds[builds.length-1].name="Rebuilt"; builds[builds.length-1].note="the same hull, the second time, with the patch in it"; }
}
const stageAt=x=>{let i=0;while(i+1<STAGES.length&&STAGES[i+1].s<=x)i++;return i;};
function pr(id,a=0,b=1,t=NOW){const w=AT[id];if(!w)return 0;return seg(t,w.s+w.d*a,w.s+w.d*b);}
function buildProgress(t){
  if(!AT.repair) return pr("build",0,1,t);
  if(t<FAIL_T) return pr("build",0,1,t);
  if(t<S("rebuild")){
    const gap=.17*seg(t,FAIL_T,FAIL_T+.7)*(1-eio(pr("repair",.40,.74,t)));   // blown off, then welded shut
    return SC.fail.at*(1-gap)*(1-eio(pr("repair",.74,1,t)));
  }
  return pr("rebuild",0,1,t);
}

/* ---------- a flat, poster-ish palette. Three moments, interpolated. ----------
   The film runs the other way round now: it starts in the dark, goes through
   the blue hour while the image is uploaded and sealed, and the sun comes up
   over the bay as she goes live. A deploy that finishes is a morning, not an
   evening — and the sun rising behind the span is a better last frame than
   one setting into an empty ocean. */
const C=h=>new THREE.Color(h);
const PALS={
  light:{
    night:{zen:0x1B2A4A,hor:0x40567A,sun:0x93A8C6,water:0x1B3450,water2:0x0F2138,foam:0x6E88A6,ggo:0xA8412A,land:0x33405A,land2:0x222C40,city:0x2E3C56,amb:1.15,key:0.7},
    blue: {zen:0x2E4F7E,hor:0xAE8894,sun:0xFFD9A8,water:0x2A4E6E,water2:0x16304A,foam:0xA8BCCC,ggo:0xC24A2C,land:0x5A5A66,land2:0x38384A,city:0x53607A,amb:1.2,key:1.4},
    dawn: {zen:0x6FB2E2,hor:0xFFD2A0,sun:0xFFF4CC,water:0x3E8FB0,water2:0x235E80,foam:0xFFF2E4,ggo:0xF2542D,land:0xC0AE6A,land2:0x87885C,city:0xB0BCCC,amb:1.7,key:2.2}
  },
  dark:{
    night:{zen:0x0B1526,hor:0x24334A,sun:0x5E7398,water:0x0D1B2E,water2:0x060D18,foam:0x36495F,ggo:0x8A3520,land:0x1B2534,land2:0x111823,city:0x1C2638,amb:0.92,key:0.45},
    blue: {zen:0x122741,hor:0x5E4658,sun:0xBE8664,water:0x14324A,water2:0x0A1B2E,foam:0x5E7488,ggo:0xA33C24,land:0x2A3644,land2:0x18212C,city:0x2C3750,amb:1.15,key:1.0},
    dawn: {zen:0x2A6A9C,hor:0xE8A268,sun:0xFFE8B4,water:0x1E5C7C,water2:0x0E3A54,foam:0xC8DCE6,ggo:0xD6512F,land:0x6E6A48,land2:0x40442E,city:0x66748A,amb:1.35,key:1.9}
  }
};
const KEYS=["zen","hor","sun","water","water2","foam","ggo","land","land2","city"];
/* THREE.lerpHSL interpolates hue linearly, so blue->red goes the long way round
   through green. Blue->red in RGB goes through grey. Neither is a sunset: take
   the short way round the wheel by hand. */
const _a={},_b={};
function lerpHue(c,to,k){
  c.getHSL(_a); to.getHSL(_b);
  let dh=_b.h-_a.h; if(dh>.5)dh-=1; else if(dh<-.5)dh+=1;
  c.setHSL((_a.h+dh*k+1)%1,_a.s+(_b.s-_a.s)*k,_a.l+(_b.l-_a.l)*k);
}
const PC={}; KEYS.forEach(k=>PC[k]=C(0));
/* GOLD — how far the sun has come up. NIGHT — how hard the artificial lights
   are working, which is the same thing running backwards. */
let PN={amb:1,key:2}, GOLD=0, NIGHT=1, SUNEL=-.08, BLUE=0;
/* The grade is pinned to light.
   This read the page's own data-theme and graded itself to match, which is why
   the frame around it could stay plain. The product is light-only now, so there
   is no attribute to read and matchMedia would have put the picture in night
   colours on a light page for anyone whose OS prefers dark. PALS.night is not
   dead — it is the film's own dusk, driven by GOLD below, not by a theme. */
/* How far the sun is allowed to have come up, given how much deploy is left.
   Story time creeps forward while a stage waits (see `paceRate`), and left
   alone that creep would have the sun fully up somewhere in the middle of a
   four-minute fleet pull — so the morning would be over before she was live.
   The sky brightens a step per stage instead: still moving, never spent. */
function dawnCeiling(){
  const left=STAGES.length-1-stage;
  return left<=0?1:left===1?.62:left===2?.34:left===3?.16:.06;
}
function palette(t){
  const P=PALS.light;
  const blue=eio(seg(t,S("upload"),E("flood")));
  const want=eio(Math.min(seg(t,S("place")+AT.place.d*.30,E("live")-2.5),dawnCeiling()));
  /* eased in wall time, not story time: the sky is a thing that is happening,
     and it should still be happening on the frame after a cut. */
  GOLD=SNAP?want:GOLD+(want-GOLD)*Math.min(1,DTW*0.55);
  BLUE=blue;
  NIGHT=1-seg(GOLD,.30,.86);
  SUNEL=lerp(lerp(-.085,-.030,blue),.085,GOLD);
  KEYS.forEach(k=>{
    PC[k].setHex(P.night[k]).lerp(C(P.blue[k]),blue);
    /* HSL for the water only: the pale sky colours would take the short way
       round through green, which is worse than the grey it fixes */
    if(k==="water"||k==="water2") lerpHue(PC[k],C(P.dawn[k]),GOLD);
    else PC[k].lerp(C(P.dawn[k]),GOLD);
  });
  PN.amb=lerp(lerp(P.night.amb,P.blue.amb,blue),P.dawn.amb,GOLD);
  PN.key=lerp(lerp(P.night.key,P.blue.key,blue),P.dawn.key,GOLD);
}

/* ---------- the world ----------
   +x runs along the bridge (−x Marin, +x the city side), −z is the ocean,
   +z is the bay. One unit is very roughly a metre. */
/* the deck is 158 up because she has to fit under it: her mast tops out at
   110 and the stiffening truss hangs 24 below the roadway, so the pass has
   ~24 of daylight in it — tight enough to be a shot, wide enough that no
   texture ever eats the radar. */
const BR={tx:640, top:400, deck:158, anch:1250, end:1520, portal:1470};
const DOCK={x:-980,z:900};
/* The moon sits over the ocean, opposite the sunrise, and stays put: it is a
   light source and a place to point the lens, not a body in an orrery. */
const MOON=new THREE.Vector3(-.40,.44,-.80).normalize();
/* the graving dock, in its own coordinates: +x is seaward, the coping is at
   +14 and the floor at −46. She is built on blocks 13 below the sea and lifts
   13 when it floods, because that is what a dry dock is — a hole you let the
   sea back into, not a slipway. `gate` is where the mitre gates hinge. */
const DK={quay:14, floor:-46, blk:-32, hw:72, x0:-206, x1:252, shipY:-13, recess:96};
/* she leaves down her own centreline: the first 430 units of the path are
   dead straight along the dock's axis, so the hull is clear of the gates and
   the dock walls before the curve starts. */
const HEAD0=0.37;
const HU={x:Math.cos(HEAD0),z:-Math.sin(HEAD0)};
const DP=(d)=>V3(DOCK.x+HU.x*d,0,DOCK.z+HU.z*d);
/* arc-length parameterised, so she keeps a steady speed and the gate lands
   inside `verify` rather than halfway through `fleet` */
const SHIP_PATH=new THREE.CatmullRomCurve3([
  DP(0), DP(215), DP(430), V3(-330,0,545),
  V3(-150,0,340), V3(-40,0,155), V3(0,0,20), V3(0,0,-120)
]);
const PATH_LEN=SHIP_PATH.getLength();
const OPEN_A=V3(0,0,-120), OPEN_B=V3(0,0,-1800);

let renderer,scene,camera,keyLight,rimLight,weldLight,ambLight,water,waterMat,skyMat,sunDisc,sunRing;
let shipG,hullParts=[],house,funnel,funnelMark=[],band,radar,radarBar,mast,flag,flagPole,
    bays=[],ribs=[],keel,deckPlate,bulwark,nameDecals=[],relDecals=[],lifeboat,
    gantry,trolley,hoist,hook,dockG,dockWater,dockGates=[],yardLamps=[],beacon,beaconLamp,
    crates=[],sparks=[],weldArc,drone,droneEye,fires=[],fireGlow,smoke=[],blackSmoke=[],debris=[],splash=[],
    clouds=[],birds=[],fogs=[],boats=[],tug,buoy,buoyLamp,landMesh,cars=[],carLamps=[],
    cityG,alcatraz,plateClip,OUTLINE,OUTLINE_CLIP,RAMP;
/* Everything the camera is not allowed to be inside of. Kept as a flat list
   rather than walked off the scene, because most of the scene — sky, water,
   sun, smoke, every spark — is either unreachable or something the lens is
   welcome to pass through, and a raycast per frame is only cheap if it is
   pointed at the six things that matter. */
let COLLIDERS=[];
/* Things that only exist after dark: [object, howBrightAtNight]. */
let nightLamps=[],ferries=[],trucks=[],welders=[],aircraft,cityWinMats=[],
    shedWins=[],lightPools=[],alcBeam,towerBlinks=[],shipWins=[],deckFloods=[],
    yardSparks=[],gantryLoad,cityLights,crew=[];

/* toon ramp: four bands, no blending between them */
function ramp(){
  const px=new Uint8Array([48,120,200,255]);
  const t=new THREE.DataTexture(px,px.length,1,THREE.RedFormat);
  t.needsUpdate=true;t.minFilter=t.magFilter=THREE.NearestFilter;t.generateMipmaps=false;
  return t;
}
function toon(color,clip){
  const m=new THREE.MeshToonMaterial({color,gradientMap:RAMP});
  if(clip)m.clippingPlanes=[plateClip];
  return m;
}
/* the cel outline: the same geometry, inverted, grown by a constant world width */
function outline(mesh,w,clip){
  w=w||2;
  const g=mesh.geometry;
  if(!g.boundingBox) g.computeBoundingBox();
  const s=g.boundingBox.getSize(new THREE.Vector3());
  const c=g.boundingBox.getCenter(new THREE.Vector3());
  const o=new THREE.Mesh(g,clip?OUTLINE_CLIP:OUTLINE);
  o.scale.set(1+2*w/Math.max(s.x,1e-3),1+2*w/Math.max(s.y,1e-3),1+2*w/Math.max(s.z,1e-3));
  o.position.set(c.x*(1-o.scale.x),c.y*(1-o.scale.y),c.z*(1-o.scale.z));
  o.renderOrder=-1;
  /* the camera raycasts against this world every frame to keep itself out of
     the geometry, and an outline is the same surface again, two units bigger:
     hitting it tells us nothing and costs as much as hitting the real thing. */
  o.raycast=()=>{};
  mesh.add(o);
  return mesh;
}
function box(w,h,d,m,x,y,z,parent,ol,clip){
  const e=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);
  e.position.set(x||0,y||0,z||0);e.castShadow=true;e.receiveShadow=true;
  (parent||scene).add(e); if(ol!==false) outline(e,ol||2,clip);
  return e;
}
function cyl(rt,rb,h,seg,m,x,y,z,parent,ol){
  const e=new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,seg),m);
  e.position.set(x||0,y||0,z||0);e.castShadow=true;
  (parent||scene).add(e); if(ol!==false) outline(e,ol||2);
  return e;
}
function tex(w,h,draw){
  const c=document.createElement("canvas");c.width=w;c.height=h;
  const x=c.getContext("2d");draw(x,w,h);
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=4;t.needsUpdate=true;return t;
}
/* the supersonic mark, from the landing page: M5 3l14 8-6 1.5-1.6 6.5z in a 24-box */
function markPath(g,cx,cy,s){
  g.beginPath();
  g.moveTo(cx+(5-12)*s,cy+(3-12)*s);
  g.lineTo(cx+(19-12)*s,cy+(11-12)*s);
  g.lineTo(cx+(13-12)*s,cy+(12.5-12)*s);
  g.lineTo(cx+(11.4-12)*s,cy+(19-12)*s);
  g.closePath();g.fill();
}

/* ---------- terrain: cel bands, flat-shaded, per face ---------- */
function bandGeo(g,bands){
  const n=g.toNonIndexed(),p=n.attributes.position,cn=p.count;
  const col=new Float32Array(cn*3);
  for(let i=0;i<cn;i+=3){
    const h=(p.getY(i)+p.getY(i+1)+p.getY(i+2))/3;
    let b=bands[0];
    for(const x of bands) if(h>=x.h) b=x;
    for(let j=0;j<3;j++){col[(i+j)*3]=b.c[0];col[(i+j)*3+1]=b.c[1];col[(i+j)*3+2]=b.c[2];}
  }
  n.setAttribute("color",new THREE.BufferAttribute(col,3));
  n.computeVertexNormals();n.computeBoundingBox();
  return n;
}
const LAND_BANDS=[{h:-1e5,c:[.62,.66,.70]},{h:6,c:[1.28,1.24,1.05]},{h:26,c:[.72,.74,.66]},
                  {h:96,c:[1.06,1.02,.80]},{h:210,c:[.84,.88,.66]},{h:330,c:[.66,.72,.56]}];
/* A plane has an edge and a coastline does not. Left alone, every one of these
   ends in a vertical cliff with the sky behind it, and a wide shot — the
   establisher, the pull-back at sunrise — reads as a diorama on a table. So
   the outer third of every terrain is drowned: the land bends down under the
   sea before the model runs out, and what the camera sees at the edge of the
   world is water going into haze, which is what the edge of the world is. */
const DROWN=340;   // how long the land takes to go under, once it starts
/* `dr` is where the drowning STARTS, per side: {xl,xh,zl,zh}. Each is optional
   and each has to sit at least DROWN inside the plane's own edge, or the model
   still ends in a cliff — just a shorter one. */
function terrain(cx,cz,w,d,sw,sd,hf,mat,dr){
  const g=new THREE.PlaneGeometry(w,d,sw,sd);
  g.rotateX(-Math.PI/2); g.translate(cx,0,cz);
  const p=g.attributes.position;
  const lo=(v,b)=>b===undefined?1:cl(1-(b-v)/DROWN);
  const hi=(v,b)=>b===undefined?1:cl(1-(v-b)/DROWN);
  dr=dr||{};
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),z=p.getZ(i);
    const f=Math.min(lo(x,dr.xl),hi(x,dr.xh),lo(z,dr.zl),hi(z,dr.zh));
    p.setY(i,f>=1?hf(x,z):lerp(-130,hf(x,z),eio(f)));
  }
  const m=new THREE.Mesh(bandGeo(g,LAND_BANDS),mat);
  m.receiveShadow=true; scene.add(m); COLLIDERS.push(m); return m;
}
/* ---------- the far shore ----------
   One ring of hills at the edge of sight, opening out to nothing over the
   ocean, which is south-west of the gate and is the only direction with no
   land in it. It is mostly fog by the time it reaches the lens; that is the
   point. Without it a wide shot ends in a horizon with a seam in it. */
function buildBackdrop(){
  const R=5200, N=224, base=-140;
  const ridge=a=>{
    const land=cl((Math.sin(a)+.86)/1.5);                 // −z is the open sea
    let h=lerp(-120,300,Math.pow(land,.8));
    h+=(122*Math.sin(a*3.1+1.4)+68*Math.sin(a*7.3-.6)+31*Math.sin(a*13.9+2.2))*land;
    return h;
  };
  const pos=[],col=[],idx=[];
  for(let i=0;i<=N;i++){
    const a=i/N*Math.PI*2, x=Math.cos(a)*R, z=Math.sin(a)*R, h=ridge(a);
    pos.push(x,base,z, x,h,z);
    col.push(.42,.46,.50, .70,.72,.68);
    if(i<N){const b=i*2;idx.push(b,b+1,b+2, b+1,b+3,b+2);}
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute("color",new THREE.Float32BufferAttribute(col,3));
  g.setIndex(idx); g.computeVertexNormals();
  const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide}));
  m.renderOrder=-3; scene.add(m); scene.userData.backdrop=m; return m;
}
/* the Marin side: steep, folded, gouged out where the yard is */
function hN(x,z){
  /* the headland has to be taller than the deck by the time the road reaches
     the portal, or the tunnel mouth stands in mid-air */
  const t=cl((-x-1050)/700);
  let h=-52+430*Math.pow(t,.86);
  h+=94*Math.sin(x*.0031+1.2)*Math.cos(z*.0026);
  h+=48*Math.sin(z*.0057+.4)*Math.sin(x*.0041);
  h+=22*Math.sin((x+z)*.0091);
  /* the far ridgeline. The base curve saturates, so without this the back of
     the headland is a table with a straight edge on it — which is exactly
     what a wide shot found. */
  h+=124*Math.sin(x*.00104+2.1)*Math.cos(z*.00082-.7)*t;
  const road=Math.exp(-Math.pow(z/210,2));            // the road cuts a saddle
  h=lerp(h,Math.min(h,BR.deck+26),road*.92);
  return yard(h,x,z);
}
/* ---------- the ground the yard stands on ----------
   The dry dock used to be a set of concrete boxes on a patch of seabed cut to
   thirty-four below, which meant the whole yard read as a raft moored in open
   water: no land behind it, sea lapping the back wall. Three cuts fix it, in
   this order, and they have to be in this order —

     the SHELF: a flat bench at coping level, cut into the hill, which is what
       a yard is and what everything on the quay is standing on;
     the HOLE: the graving dock itself, taken back out of the shelf, down
       below its own floor so the terrain never pokes through it;
     the CHANNEL: a trench from the gates out to deep water, because a dry
       dock with land across its mouth is a swimming pool and she would never
       get out of it. */
function yard(h,x,z){
  const rx=x-DOCK.x, rz=z-DOCK.z;
  const lx=rx*HU.x+rz*HU.z, lz=rx*(-HU.z)+rz*HU.x, az=Math.abs(lz);
  h=lerp(h,DK.quay-6,cl(Math.exp(-(Math.pow(lx/640,2)+Math.pow(lz/450,2)))*1.28));
  const hole=cl(1-(Math.max(0,Math.max(DK.x0-46-lx,lx-(DK.x1+34)))+Math.max(0,az-116))/40);
  h=lerp(h,DK.floor-14,hole);
  const chan=cl(1-(Math.max(0,DK.x1+10-lx)+Math.max(0,az-150))/130);
  return Math.min(h,lerp(h,-46,chan));
}
/* the city side: a lower bluff, then the land runs away east — and, north of
   the bluff, the low shelf the city itself stands on. Without that shelf the
   far two-thirds of the skyline was standing in open water, which is fine
   until a wide shot catches it side-on. The shelf stops short of Alcatraz, so
   the rock stays a rock. */
function hS(x,z){
  const t=cl((x-1050)/700);
  let h=-46+330*Math.pow(t,.8);
  h+=54*Math.sin(x*.0027-.6)*Math.cos(z*.0031+1.1);
  h+=30*Math.sin(z*.0049+2.2);
  h+=96*Math.sin(x*.00097-1.4)*Math.cos(z*.00071+2.3)*t;   // and its ridgeline
  const road=Math.exp(-Math.pow(z/240,2));
  h=lerp(h,Math.min(h,BR.deck-8),road*.9);
  const city=cl((z-1180)/260)*cl((x-1330)/300);
  h=lerp(h,6+34*cl((z-2400)/2000)+9*Math.sin(x*.0031)*Math.cos(z*.0029),city*.94);
  return h;
}
function hAlc(x,z){
  const r=Math.hypot((x-1180)/190,(z-1460)/135);
  return 54*(1-Math.pow(cl(r),1.6))-16+7*Math.sin(x*.05)*Math.cos(z*.05);
}

/* ---------- the Gate ---------- */
function buildBridge(){
  const orange=toon(PC.ggo), dark=toon(PC.ggo.clone().multiplyScalar(.62)),
        steel=toon(0x5C6670), road=toon(0x3A3B38);
  scene.userData.orange=orange; scene.userData.dark=dark;
  const B=new THREE.Group(); scene.add(B); scene.userData.bridge=B;

  /* deck: roadway, stiffening truss, kerbs. Runs into the hills at both ends. */
  const len=2*BR.end;
  box(len,7,80,road,0,BR.deck+5,0,B,false);
  box(len,9,90,orange,0,BR.deck,0,B,2.6);
  box(len,20,60,dark,0,BR.deck-14,0,B,false);
  [-45,45].forEach(dz=>box(len,10,5,orange,0,BR.deck+12,dz,B,false));
  /* lamp posts + their glow */
  for(let x=-BR.end+60;x<=BR.end-60;x+=118){
    box(4,26,4,orange,x,BR.deck+22,-45,B,false);
    box(4,26,4,orange,x,BR.deck+22,45,B,false);
    [-45,45].forEach(dz=>{
      const l=new THREE.Mesh(new THREE.SphereGeometry(5,7,6),new THREE.MeshBasicMaterial({color:0xFFD8A0,fog:false,transparent:true,opacity:0}));
      l.position.set(x,BR.deck+36,dz);B.add(l);carLamps.push(l);
    });
  }

  /* towers: stepped shafts, portal braces, a base pier in the water */
  [-BR.tx,BR.tx].forEach(tx=>{
    box(120,26,150,dark,tx,10,0,B,2.6);
    [-38,38].forEach(dz=>{
      for(let i=0;i<6;i++){
        const y0=BR.top*i/6,y1=BR.top*(i+1)/6,w=lerp(40,22,i/6);
        box(w,y1-y0,w*1.28,orange,tx,(y0+y1)/2,dz,B,2.4);
      }
    });
    for(let i=0;i<5;i++) box(112,i<1?26:15,26,orange,tx,lerp(26,BR.top-22,i/4),0,B,2.4);
    box(96,10,96,orange,tx,BR.top+6,0,B,2.4);
    /* the two red lights on top of each tower, out of phase with each other,
       which is the one thing a bridge is doing at three in the morning */
    [-30,30].forEach((dz,j)=>{
      const b=new THREE.Mesh(new THREE.SphereGeometry(7,8,7),
        new THREE.MeshBasicMaterial({color:0xFF4632,fog:false,transparent:true,opacity:0}));
      b.position.set(tx,BR.top+16,dz); B.add(b);
      towerBlinks.push({m:b,ph:j*3.14+(tx<0?0:1.6)});
    });
  });

  /* cables: main span parabola over the towers, side spans down to the anchorages */
  const cabY=x=>{const u=Math.abs(x)/BR.tx;return BR.deck+30+(BR.top-16-BR.deck-30)*u*u;};
  const sideY=x=>{const u=(Math.abs(x)-BR.tx)/(BR.anch-BR.tx);return lerp(BR.top-16,BR.deck+52,Math.pow(u,.72));};
  const cy=x=>Math.abs(x)<=BR.tx?cabY(x):sideY(x);
  [-38,38].forEach(dz=>{
    const pts=[];
    for(let x=-BR.anch;x<=BR.anch;x+=30) pts.push(V3(x,cy(x),dz));
    const c=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),190,7.5,7,false),orange);
    c.castShadow=true;B.add(c);
    for(let x=-BR.anch+46;x<=BR.anch-46;x+=40){
      const top=cy(x);
      if(top<=BR.deck+16||Math.abs(Math.abs(x)-BR.tx)<44) continue;
      const h=top-BR.deck-6;
      const e=new THREE.Mesh(new THREE.CylinderGeometry(2.2,2.2,h,5),orange);
      e.position.set(x,BR.deck+6+h/2,dz);B.add(e);
    }
  });
  /* anchorage blocks, then the viaduct that carries the road into the hill */
  [-1,1].forEach(s=>{
    box(150,BR.deck+96,190,toon(0x9E9A8C),s*BR.anch,(BR.deck+96)/2-30,0,B,2.6);
    for(let x=BR.anch+90;x<BR.portal;x+=110) box(26,BR.deck-8,26,steel,s*x,(BR.deck-8)/2,0,B,2.4);
    /* the portal: the road keeps going, into the rock */
    const p=box(56,86,150,toon(0x2A2C28),s*BR.portal,BR.deck-6,0,B,2.6);
    p.renderOrder=1;
    box(30,64,120,new THREE.MeshBasicMaterial({color:0x120F0E}),s*(BR.portal-30*s/Math.abs(s)),BR.deck-14,0,B,false);
  });

  /* traffic */
  const carMat=[toon(0xE8E4DA),toon(0x2E3C48),toon(0xB03A22),toon(0x2F7F58),toon(0x8C93A0),toon(0xE0A93A)];
  rs(7);
  for(let i=0;i<26;i++){
    const dir=i%2?1:-1, z=dir>0?-22:22;
    const c=box(rnd()<.25?34:20,rnd()<.25?13:9,10,pick(carMat),0,BR.deck+15,z,B,1.4);
    c.userData={dir,x:-BR.end+((i*118)%(2*BR.end)),spd:52+rnd()*26,z};
    cars.push(c);
    const l=new THREE.Mesh(new THREE.SphereGeometry(3,6,5),new THREE.MeshBasicMaterial({color:dir>0?0xFFE6B0:0xFF5A3C,fog:false,transparent:true,opacity:0}));
    B.add(l);c.userData.lamp=l;carLamps.push(l);
  }

  /* the two things at the foot of the towers that say which bridge this is */
  const lh=new THREE.Group(); lh.position.set(-BR.tx+8,0,86); scene.add(lh);
  cyl(11,13,44,10,toon(0xF2EEE2),0,22,0,lh);
  cyl(9,9,7,10,toon(0xB03A22),0,47,0,lh);
  const lamp=new THREE.Mesh(new THREE.SphereGeometry(5,8,6),new THREE.MeshBasicMaterial({color:0xFFF0B0,fog:false}));
  lamp.position.y=53;lh.add(lamp);lh.userData.lamp=lamp;beacon=lh;beaconLamp=lamp;
  box(56,20,30,toon(0xE8E2D2),26,10,0,lh,2);
  /* Fort Point, under the city-side tower */
  const fp=new THREE.Group(); fp.position.set(BR.tx-30,0,104); scene.add(fp);
  box(120,44,84,toon(0x7A4A38),0,20,0,fp,2.4);
  box(96,10,64,toon(0x8E5A44),0,46,0,fp,2);
  for(let i=-2;i<=2;i++) box(14,16,4,new THREE.MeshBasicMaterial({color:0x241C18}),i*22,18,43,fp,false);
}

/* ---------- the far city ----------
   A skyline is not a scatter of boxes: it is a downtown that peaks somewhere
   and falls away to both sides, towers that step in as they rise, a waterfront
   of low sheds and piers in front, and — at night, which is most of this film
   — a hundred lit windows that read from two kilometres away. */
function buildCity(){
  cityG=new THREE.Group(); scene.add(cityG);
  const m=toon(PC.city); scene.userData.cityMat=m;
  const m2=toon(PC.city.clone().multiplyScalar(.82)); scene.userData.cityMat2=m2;
  /* Six window materials, not one. A city where every lit window comes on and
     goes off together is a city with one light switch — the eye reads it as a
     texture rather than as people. Six banks, each on its own slow flicker,
     and the towers drawn from them at random, is enough to read as a hundred
     thousand rooms none of which is our business. */
  cityWinMats=[];
  for(let i=0;i<6;i++) cityWinMats.push(new THREE.MeshBasicMaterial(
    {color:i%3?0xFFDCA0:0xFFEDC6,fog:false,transparent:true,opacity:0}));
  const wm=cityWinMats[0];
  scene.userData.winMat=wm;
  const CX=2050, CZ=2150;                       // downtown, and how far out it reaches
  rs(31);
  /* the towers. Height falls off with distance from the core, with noise, so
     the silhouette has a peak and shoulders instead of a flat hedge. */
  for(let i=0;i<86;i++){
    const a=rnd()*6.283, r=Math.pow(rnd(),.62)*1500;
    const x=CX+Math.cos(a)*r*1.15, z=CZ+Math.sin(a)*r*.8;
    if(z<1420||x<1120) continue;                // nothing standing in the water
    const core=Math.exp(-Math.pow(r/720,1.7));
    const h=54+core*330*(.55+rnd()*.75)+rnd()*46;
    const w=34+rnd()*30+core*22, d=w*(.75+rnd()*.5);
    box(w,h,d,rnd()<.3?m2:m,x,h/2-6,z,cityG,2.6);
    if(h>150&&rnd()<.55) box(w*.66,h*.22,d*.66,m,x,h+h*.11-6,z,cityG,2.4);   // a setback
    if(h>230&&rnd()<.5)  cyl(1.6,2.4,40,5,m,x,h+h*.22+14,z,cityG,1.4);       // a mast
    /* lit windows: banked planes per tower, on two faces, so a tower seen from
       the side is lit too and the skyline has depth after dark */
    if(rnd()<.92){
      const rows=Math.max(3,Math.round(h/38));
      const wmA=cityWinMats[(rnd()*6)|0], wmB=cityWinMats[(rnd()*6)|0];
      for(let r2=0;r2<rows;r2++){
        const y=22+r2*(h-34)/rows;
        const pw=new THREE.Mesh(new THREE.PlaneGeometry(w*.74,5.5),wmA);
        pw.position.set(x,y,z-d/2-1.2);cityG.add(pw);
        if(rnd()<.7){
          const ps=new THREE.Mesh(new THREE.PlaneGeometry(d*.74,5.5),wmB);
          ps.position.set(x-w/2-1.2,y,z);ps.rotation.y=-Math.PI/2;cityG.add(ps);
        }
      }
      /* the red light on top of anything tall enough to hit */
      if(h>250){
        const b=new THREE.Mesh(new THREE.SphereGeometry(4,7,6),
          new THREE.MeshBasicMaterial({color:0xFF4632,fog:false,transparent:true,opacity:0}));
        b.position.set(x,h+8,z);cityG.add(b);towerBlinks.push({m:b,ph:rnd()*6.283});
      }
    }
  }
  /* the one everybody draws */
  const py=new THREE.Mesh(new THREE.ConeGeometry(44,330,4),m);
  py.position.set(1930,159,2010);py.rotation.y=Math.PI/4;cityG.add(py);outline(py,2.6);
  /* the waterfront: low sheds and finger piers, so the city meets the bay */
  const pier=toon(0x6E6A60);
  rs(77);
  for(let i=0;i<9;i++){
    const x=1360+i*230+rnd()*60;
    box(90+rnd()*70,26,150,pier,x,7,1466,cityG,2.2);
    box(34,14,190+rnd()*90,pier,x+60,2,1330,cityG,2);     // the pier itself
  }
  /* Street lights. Towers alone give a city a silhouette and no ground: the
     thing that says a place is inhabited at four in the morning is the light
     lying in the streets between the buildings, and two thousand of those is
     one Points call. Along the Embarcadero first, then a grid going back. */
  const lp=[];
  rs(97);
  for(let i=0;i<64;i++) lp.push(1240+i*38+rnd()*10, 12+rnd()*4, 1494+Math.sin(i*.3)*22);
  for(let i=0;i<16;i++){
    const gx=1420+i*150;
    for(let j=0;j<34;j++) lp.push(gx+rnd()*22-11, 14+rnd()*30+j*1.6, 1560+j*74+rnd()*26);
  }
  for(let i=0;i<520;i++) lp.push(1200+rnd()*3000, 10+rnd()*70, 1500+rnd()*2400);
  cityLights=new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute(lp,3)),
    new THREE.PointsMaterial({color:0xFFD9A0,size:7,sizeAttenuation:true,fog:true,transparent:true,opacity:0,depthWrite:false}));
  cityG.add(cityLights);
}

/* ---------- the water ---------- */
function buildWater(){
  waterMat=new THREE.ShaderMaterial({
    uniforms:{c1:{value:PC.water.clone()},c2:{value:PC.water2.clone()},foam:{value:PC.foam.clone()},
              sun:{value:PC.sun.clone()},time:{value:0},dusk:{value:0},fogColor:{value:new THREE.Color()},
              night:{value:1},lights:{value:new THREE.Color(0xFFCE86)},
              moonAz:{value:new THREE.Vector2(MOON.x,MOON.z).normalize()},moon:{value:1},
              fogNear:{value:1400},fogFar:{value:7000},
              shipPos:{value:V3(0,0,0)},shipDir:{value:new THREE.Vector2(0,-1)},wake:{value:0},
              /* the dry dock is a hole in the sea until the gates open */
              dockC:{value:new THREE.Vector2(DOCK.x,DOCK.z)},
              dockU:{value:new THREE.Vector2(HU.x,HU.z)},
              dockB:{value:V3(DK.x0-30,DK.x1,DK.hw+8)},dockCut:{value:1}},
    vertexShader:`varying vec3 wp; varying float vDepth;
      void main(){ vec4 w=modelMatrix*vec4(position,1.); wp=w.xyz;
        vec4 mv=viewMatrix*w; vDepth=-mv.z; gl_Position=projectionMatrix*mv; }`,
    fragmentShader:`
      uniform vec3 c1,c2,foam,sun,fogColor,shipPos,dockB,lights; uniform vec2 shipDir,dockC,dockU;
      uniform float time,dusk,fogNear,fogFar,wake,dockCut,night,moon;
      uniform vec2 moonAz;
      varying vec3 wp; varying float vDepth;
      void main(){
        if(dockCut>0.5){
          vec2 rel=wp.xz-dockC;
          float lx=dot(rel,dockU), lz=dot(rel,vec2(-dockU.y,dockU.x));
          if(lx>dockB.x&&lx<dockB.y&&abs(lz)<dockB.z) discard;
        }
        float d=clamp(vDepth/6400.,0.,1.);
        vec3 c=mix(c1,c2,smoothstep(0.,1.,d));
        float w=sin(wp.x*.013+time*1.1)+sin(wp.z*.090-time*.85)+sin((wp.x*.22+wp.z)*.041+time*.5);
        c=mix(c,foam,smoothstep(2.55,2.72,w)*0.62);
        c=mix(c,foam,smoothstep(-2.62,-2.45,-w)*0.18);
        float road=exp(-abs(wp.x-wp.z*0.29)/(60.+(1.-d)*460.));
        c=mix(c,sun,road*(0.06+0.62*dusk));
        // The shore, lying on the water. Half of this film happens at night on
        // a bay ringed with lit things, and a black sheet under a lit city is
        // the one thing that made the water read as a floor rather than water.
        // Broken up by the same wave the foam uses, so it is reflection and
        // not a painted smear.
        // the moon on the water, broken into a path by a finer wave than the
        // one the foam uses — a smear reads as paint, a path reads as light
        // Fine enough to be glitter, coarse enough not to alias into gravel —
        // and faded out with distance, because a texture this size a kilometre
        // away is a moire pattern rather than light on water.
        float fine=sin(wp.x*.094-time*2.1)+sin(wp.z*.113+time*1.7)+sin((wp.x-wp.z)*.068+time*1.1);
        float near=1.0-smoothstep(0.04,0.22,d);
        float mpath=exp(-abs(wp.x*moonAz.y-wp.z*moonAz.x)/(38.+(1.-d)*250.));
        c=mix(c,vec3(0.74,0.80,0.94),clamp(mpath*(0.20+0.40*smoothstep(0.6,2.4,fine)*near)*moon,0.,0.66));
        float glit=0.24+0.52*smoothstep(-0.2,2.1,w)+0.20*smoothstep(1.1,2.6,fine)*near;
        float city=exp(-abs(wp.x-1980.)/1250.)*exp(-abs(wp.z-1780.)/1000.);
        float span=exp(-abs(wp.z-20.)/260.)*exp(-abs(abs(wp.x)-560.)/820.);
        float yard=exp(-abs(wp.x+980.)/460.)*exp(-abs(wp.z-880.)/420.);
        c=mix(c,lights,clamp((city*0.80+span*0.50+yard*0.62)*glit*night,0.,0.66));
        // her wake: two arms and the churned water between them
        vec2 rel=wp.xz-shipPos.xz;
        float back=dot(rel,-shipDir);
        float lat=abs(dot(rel,vec2(-shipDir.y,shipDir.x)));
        float arm=smoothstep(9.,0.,abs(lat-back*0.30))*step(0.,back)*exp(-back/900.);
        float trail=smoothstep(46.,0.,lat)*step(0.,back)*exp(-back/420.);
        float bow=smoothstep(64.,0.,length(rel))*step(back,0.);
        c=mix(c,foam,clamp(arm*0.95+trail*0.42+bow*0.5,0.,1.)*wake);
        float fres=pow(1.-abs(normalize(cameraPosition-wp).y),4.);
        c=mix(c,mix(c2,sun,0.25*dusk),fres*0.55);
        float f=smoothstep(fogNear,fogFar,vDepth);
        gl_FragColor=vec4(mix(c,fogColor,f),1.);
      }`});
  water=new THREE.Mesh(new THREE.PlaneGeometry(30000,30000),waterMat);
  water.rotation.x=-Math.PI/2; scene.add(water);
}

/* ---------- the ship ----------
   Side profile with sheer, a raked flared stem and a bulbous bow, extruded
   and then squeezed in z so she has a shape instead of a thickness. */
function hullShape(low){
  const s=new THREE.Shape();
  if(low){
    s.moveTo(-116,3); s.lineTo(-116,-4);
    s.quadraticCurveTo(-114,-17,-96,-17);
    s.lineTo(96,-17);
    s.quadraticCurveTo(118,-17,124,-9);      // the bulb
    s.quadraticCurveTo(128,-4,112,3);
    s.closePath();
  }else{
    s.moveTo(-122,33); s.lineTo(-117,3);
    s.lineTo(112,3);
    s.quadraticCurveTo(122,14,126,39);        // flared stem
    s.quadraticCurveTo(20,26,-122,33);        // the sheer
    s.closePath();
  }
  return s;
}
function hullGeo(low){
  const g=new THREE.ExtrudeGeometry(hullShape(low),
    {depth:62,bevelEnabled:true,bevelSize:2.5,bevelThickness:2.5,bevelSegments:2,curveSegments:10});
  g.translate(0,0,-31);
  const p=g.attributes.position;
  for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    let k=1;
    if(x>40) k*=1-.92*Math.pow(cl((x-40)/86),1.35);        // fine bow
    if(x<-72) k*=1-.34*Math.pow(cl((-x-72)/50),1.5);       // tucked stern
    if(y<-2) k*=1-.30*Math.pow(cl((-y-2)/15),1.7);         // deadrise
    if(low&&x>108) k=Math.max(k,.30*(1-cl((x-108)/20)));   // keep the bulb round
    p.setZ(i,z*k);
  }
  g.computeVertexNormals(); g.computeBoundingBox();
  return g;
}
/* ---------- her plan, so that what sits on her fits inside her ----------
   The squeeze above, said once and out loud. Forward of midships she is a
   third of her beam and at the transom two thirds of it, and the first cut of
   this drew everything ON her — the deck, the hatch strips, the frames, the
   keel, the forecastle — as plain boxes at FULL beam. So they came out
   through her sides: a row of frames standing proud of the sheer and hanging
   out past the bow, which is not a ship, it is a caterpillar. Anything cut to
   `beam(x)` cannot do that. */
const beamK=x=>{
  let k=1;
  if(x>40) k*=1-.92*Math.pow(cl((x-40)/86),1.35);
  if(x<-72) k*=1-.34*Math.pow(cl((-x-72)/50),1.5);
  return k;
};
/** Half her width at x, a shade inside the plating. */
const beam=x=>Math.max(2,31*beamK(x)-1.5);
/**
 * A slab cut to her plan: a top view of her between x0 and x1, extruded down
 * from `y` by `h`, pulled in from the plating by `inset`. This is the deck,
 * the boot-top stripe and the forecastle — the three things that are long
 * enough for the taper to matter.
 */
function slab(x0,x1,y,h,inset,m,parent,ol,clip){
  const s=new THREE.Shape(), N=28, X=i=>x0+(x1-x0)*i/N, w=i=>Math.max(1.5,beam(X(i))-inset);
  s.moveTo(X(0),w(0));
  for(let i=1;i<=N;i++) s.lineTo(X(i),w(i));
  for(let i=N;i>=0;i--) s.lineTo(X(i),-w(i));
  s.closePath();
  const g=new THREE.ExtrudeGeometry(s,{depth:h,bevelEnabled:false});
  g.rotateX(Math.PI/2);            // a plan becomes a deck
  g.translate(0,y,0);              // hung from its top face
  g.computeVertexNormals(); g.computeBoundingBox();
  const e=new THREE.Mesh(g,m); e.castShadow=true; e.receiveShadow=true;
  (parent||scene).add(e); if(ol!==false) outline(e,ol||2,clip);
  return e;
}
function buildShip(){
  shipG=new THREE.Group(); scene.add(shipG);
  plateClip.normal.set(-1,0,0); plateClip.constant=0;
  const topsides=toon(0x2E3C48,1), boot=toon(0xA8342A,1), deckM=toon(0x54606B,1),
        white=toon(0xF2EEE2,1), dark=toon(0x2A3038,1);
  hullParts=[];
  const up=new THREE.Mesh(hullGeo(false),topsides); up.castShadow=true; shipG.add(up); hullParts.push(up);
  const lo=new THREE.Mesh(hullGeo(true),boot); lo.castShadow=true; shipG.add(lo); hullParts.push(lo);
  const oh=new THREE.Mesh(up.geometry,OUTLINE_CLIP);
  oh.scale.set(1.022,1.07,1.07); oh.position.y=-1.2; oh.renderOrder=-1; oh.raycast=()=>{}; up.add(oh);
  const ol2=new THREE.Mesh(lo.geometry,OUTLINE_CLIP);
  ol2.scale.set(1.018,1.10,1.06); ol2.position.y=.6; ol2.renderOrder=-1; ol2.raycast=()=>{}; lo.add(ol2);
  /* the boot-top line, and the hatch deck — cut to her plan, so they end
     where her sides end instead of hanging out past the bow */
  hullParts.push(slab(-120,113,5.5,3,.5,toon(0xE8E2D2,1),shipG,false,1));
  deckPlate=slab(-121,113,33.5,5,2,deckM,shipG,false,1); hullParts.push(deckPlate);
  for(let i=0;i<6;i++){ const hx=-52+i*24;
    hullParts.push(box(4,3,2*(beam(hx)-4),dark,hx,34,0,shipG,false,1)); }
  /* forecastle + bulwark + the anchor */
  bulwark=slab(73,116,44.5,13,0,topsides,shipG,2,1); hullParts.push(bulwark);
  hullParts.push(slab(75,112,46.5,7,3,deckM,shipG,false,1));
  [1,-1].forEach(s2=>hullParts.push(
    box(9,13,3,toon(0x1E242B,1),108,26,s2*(beam(108)+1.4),shipG,false,1)));
  /* keel + frames, for the build. Both stop under the deck and inside the
     plating: a frame at full beam comes out through her bow, and a frame that
     stands proud of the sheer is a sleeper, not a frame. */
  keel=box(200,8,18,toon(0x1E2630),-12,-15,0,shipG,false);
  const ribMat=toon(0x44515D);
  ribs=[];
  for(let i=0;i<10;i++){
    const rx=-104+i*23;
    const e=box(6,44,2*Math.max(4,beam(rx)-3.5),ribMat,rx,6,0,shipG,false);
    e.visible=false;ribs.push(e);
  }
  /* the house: four decks, a bridge with wings, windows */
  house=new THREE.Group(); house.position.set(-88,31,0); shipG.add(house);
  const hb=box(56,40,52,white,0,20,0,house,2.2);
  const br=box(50,13,60,white,0,47,0,house,2.2);
  box(96,7,13,white,0,45,0,house,2);                       // the wings
  for(let d=0;d<3;d++) for(let s2=-1;s2<=1;s2+=2)
    box(48,6,2,dark,0,10+d*11,s2*26.4,house,false);
  box(44,8,2,dark,0,47,30.6,house,false);
  box(44,8,2,dark,0,47,-30.6,house,false);
  box(10,9,10,white,-20,57,0,house,2);
  /* she is lit from inside once she has a house to be lit inside of — three
     decks of accommodation and a bridge with somebody on it */
  shipWins=[];
  const swm=new THREE.MeshBasicMaterial({color:0xFFE7B8,fog:false,transparent:true,opacity:0});
  shipWins.push(swm);
  for(let d=0;d<3;d++) for(let s2=-1;s2<=1;s2+=2){
    const w=new THREE.Mesh(new THREE.PlaneGeometry(46,4.4),swm);
    w.position.set(0,10+d*11,s2*27); if(s2<0)w.rotation.y=Math.PI; house.add(w);
  }
  [30.9,-30.9].forEach(z=>{
    const w=new THREE.Mesh(new THREE.PlaneGeometry(42,6.4),swm);
    w.position.set(0,47,z); if(z<0)w.rotation.y=Math.PI; house.add(w);
  });
  /* deck floods on the wings, pointed at the work */
  deckFloods=[];
  [[-24,44],[24,44]].forEach(([x,y])=>{
    const l=new THREE.Mesh(new THREE.SphereGeometry(3.4,7,6),
      new THREE.MeshBasicMaterial({color:0xFFF0C8,fog:false,transparent:true,opacity:0}));
    l.position.set(x,y,0); house.add(l); deckFloods.push(l);
  });
  /* radar mast on the house. Everything above the funnel is air draft, and
     air draft is what has to fit under the span: her highest point is 110. */
  mast=new THREE.Group(); mast.position.set(-8,54,0); house.add(mast);
  cyl(2.4,3,20,7,white,0,10,0,mast);
  radarBar=box(24,2.4,5,toon(0xE8E2D2),0,20,0,mast,1.4);
  box(3,7,3,white,0,25,0,mast,false);
  /* funnel, with the mark and the release number */
  funnel=new THREE.Group(); funnel.position.set(-104,0,0); shipG.add(funnel);
  const fb=cyl(15,17,32,14,toon(PC.ggo),0,86,0,funnel,2.2); scene.userData.funnelMesh=fb;
  band=cyl(17.6,18.2,10,14,toon(0x158043),0,97,0,funnel,false);
  const markTex=tex(256,256,(g,w,h)=>{
    g.clearRect(0,0,w,h); g.fillStyle="#F4F2EC"; markPath(g,w/2,h/2-14,8.4);
    g.fillStyle="#F4F2EC"; g.font="600 44px ui-monospace,Menlo,monospace"; g.textAlign="center";
    g.fillText("41",w/2,h-34);
  });
  [1,-1].forEach(s2=>{
    const d=new THREE.Mesh(new THREE.PlaneGeometry(26,26),
      new THREE.MeshBasicMaterial({map:markTex,transparent:true,depthWrite:false,opacity:0}));
    d.position.set(0,86,s2*15.6); if(s2<0)d.rotation.y=Math.PI;
    funnel.add(d); relDecals.push(d);
  });
  /* lifeboat aft, orange, unmistakable */
  lifeboat=box(30,12,12,toon(0xE0913A),-118,44,0,shipG,1.8);
  lifeboat.visible=false;
  /* her name, on the topsides */
  const nameTex=tex(1024,192,(g,w,h)=>{
    g.clearRect(0,0,w,h);g.fillStyle="#F4F2EC";
    /* Shrunk to fit rather than clipped: app names are slugs and some of them
       are long, and half a name on the topsides reads as a bug in the film. */
    let px=118;
    do { g.font="700 "+px+"px ui-monospace,Menlo,monospace"; px-=6; }
    while(px>34&&g.measureText(SC.app).width>w-190);
    g.textAlign="left";g.textBaseline="middle";
    g.fillText(SC.app,150,h/2);
    markPath(g,74,h/2,5.6);
  });
  [1,-1].forEach(s2=>{
    const d=new THREE.Mesh(new THREE.PlaneGeometry(112,21),
      new THREE.MeshBasicMaterial({map:nameTex,transparent:true,depthWrite:false,clippingPlanes:[plateClip]}));
    d.position.set(-6,18,s2*30.4); d.rotation.y=s2>0?0:Math.PI;
    shipG.add(d); nameDecals.push(d);
  });
  /* the ensign, at the stern */
  flagPole=cyl(1.2,1.6,30,6,toon(0xE8E2D2),-124,48,0,shipG,false);
  const flagTex=tex(256,160,(g,w,h)=>{
    g.fillStyle="#15803F";g.fillRect(0,0,w,h);
    g.fillStyle="#F4F2EC";markPath(g,w*.5,h*.5,4.6);
  });
  flag=new THREE.Mesh(new THREE.PlaneGeometry(30,18,8,1),
    new THREE.MeshBasicMaterial({map:flagTex,side:THREE.DoubleSide}));
  flag.position.set(-108,58,0); shipG.add(flag);
  /* six bays of containers — one per image layer */
  const cmat=[toon(0xC24A32),toon(0x2F6E90),toon(0x2F7F58),toon(0x8C93A0),toon(0xE0A93A),toon(0xE8E4DA)];
  const cached=toon(0x646E78);
  rs(11); bays=[];
  SC.cargo.forEach((isCached,i)=>{
    const g=new THREE.Group(); g.position.set(-56+i*25,0,0); shipG.add(g);
    const tiers=i%3===2?2:3;
    for(let r=0;r<3;r++) for(let ti=0;ti<tiers;ti++){
      if(ti===tiers-1&&rnd()<.28) continue;
      box(21,11,15,isCached?cached:pick(cmat),0,39+ti*11.6,(r-1)*17.6,g,1.5);
    }
    g.userData.cached=isCached; g.visible=false; bays.push(g);
  });
  /* wake rings, funnel smoke, black smoke, fire, debris */
  splash=[];smoke=[];blackSmoke=[];fires=[];debris=[];
  for(let i=0;i<6;i++){
    const e=new THREE.Mesh(new THREE.RingGeometry(6,12,22),
      new THREE.MeshBasicMaterial({color:PC.foam,transparent:true,opacity:.5,side:THREE.DoubleSide,depthWrite:false}));
    e.rotation.x=-Math.PI/2;e.visible=false;scene.add(e);splash.push(e);
  }
  /* Ten identical puffs on an even beat read as a string of beads, which is
     what this was. Sixteen, each with its own size and its own place in the
     beat, read as smoke. */
  rs(19);
  for(let i=0;i<16;i++){
    const e=new THREE.Mesh(new THREE.SphereGeometry(7+rnd()*5,7,6),
      new THREE.MeshBasicMaterial({color:0xF2F0EA,transparent:true,opacity:.5,depthWrite:false}));
    e.userData={off:rnd()*.062,w:.7+rnd()*.6};
    e.visible=false;scene.add(e);smoke.push(e);
  }
  for(let i=0;i<14;i++){
    const e=new THREE.Mesh(new THREE.SphereGeometry(10,7,6),
      new THREE.MeshBasicMaterial({color:0x2A2622,transparent:true,opacity:.6,depthWrite:false}));
    e.visible=false;scene.add(e);blackSmoke.push(e);
  }
  for(let i=0;i<11;i++){
    const e=new THREE.Mesh(new THREE.ConeGeometry(11,34,6),
      new THREE.MeshBasicMaterial({color:i%3?0xFFC63A:0xF2622A,fog:false,transparent:true,opacity:.92}));
    e.visible=false;shipG.add(e);fires.push(e);
  }
  fireGlow=new THREE.Mesh(new THREE.SphereGeometry(46,12,10),
    new THREE.MeshBasicMaterial({color:0xF2872A,fog:false,transparent:true,opacity:0,depthWrite:false}));
  fireGlow.visible=false;shipG.add(fireGlow);
  for(let i=0;i<7;i++){
    const e=box(20,4,26,toon(0x3A4854),0,0,0,scene,1.6);
    e.visible=false;e.userData={};debris.push(e);
  }
}

/* ---------- the yard: a graving dock ----------
   Not a slab with a slot in it. A floor, two flights of altars stepping down
   the sides, keel and bilge blocks she is built on, a head wall with a stair,
   a gate recess, and a pair of mitre gates that hold the sea out until the
   release is sealed. The gantry rides rails on the copings, where a gantry
   goes, instead of standing in the water she is supposed to float in. */
function buildYard(){
  dockGates=[]; yardLamps=[];
  dockG=new THREE.Group(); dockG.position.set(DOCK.x,0,DOCK.z); dockG.rotation.y=HEAD0; scene.add(dockG);
  const concrete=toon(0x7B7767), shadowC=toon(0x676454), coping=toon(0x9A9784),
        steel=toon(0x5C6670), floorMat=toon(0x847F6E), timber=toon(0x5E4A38);
  scene.userData.landMat=concrete; scene.userData.floorMat=floorMat;
  const W=DK.x1-DK.x0, CX=(DK.x0+DK.x1)/2, AW=W-DK.recess, ACX=DK.x0+AW/2;
  /* box between two heights, in the dock's own frame */
  const at=(x,w,z,d,y0,y1,m,ol)=>box(w,y1-y0,d,m,x,(y0+y1)/2,z,dockG,ol===undefined?false:ol);

  /* the apron: land on three sides of the hole, its top the coping level */
  at(CX-60, W+330, 250, 246, -150, DK.quay, concrete, 2.4);
  at(CX-60, W+330,-196, 138, -150, DK.quay, concrete, 2.4);
  at(DK.x0-135, 270, 0, 678, -150, DK.quay, concrete, 2.4);
  /* the hole: floor, altars, wall, coping strip */
  at(CX, W+40, 0, 300, DK.floor-20, DK.floor, floorMat);
  [-1,1].forEach(s=>{
    at(ACX, AW, s*81, 18, DK.floor, DK.floor+16, shadowC);       // first altar
    at(ACX, AW, s*99, 18, DK.floor, DK.floor+38, shadowC);       // second altar
    at(CX,  W,  s*119,22, DK.floor, DK.quay,     concrete, 2.2); // the wall
    at(CX,  W,  s*121,27, DK.quay,  DK.quay+3.5, coping);
  });
  /* head wall, and the stair down into the dock */
  at(DK.x0-13, 26, 0, 262, DK.floor, DK.quay, concrete, 2.2);
  for(let i=0;i<6;i++) at(DK.x0+7+i*13, 13, 96, 34, DK.floor, DK.floor+9+i*10, shadowC);
  /* keel blocks, and bilge blocks under the turn of her bilge */
  for(let x=DK.x0+40;x<DK.x1-96;x+=42) at(x, 28, 0, 34, DK.floor, DK.blk, timber);
  for(let x=DK.x0+60;x<DK.x1-140;x+=84) [-1,1].forEach(s=>at(x, 22, s*24, 22, DK.floor, DK.blk-6, timber));
  /* the water that comes into it */
  dockWater=new THREE.Mesh(new THREE.BoxGeometry(W-4,140,2*DK.hw-2),
    new THREE.MeshToonMaterial({color:PC.water,gradientMap:RAMP,transparent:true,opacity:.95}));
  dockWater.position.set(CX,DK.floor-70,0);dockG.add(dockWater);

  /* the mitre gates: closed they point seaward against the sea's own push,
     open they fold back into the recess in the walls */
  dockGates=[];
  [-1,1].forEach(s=>{
    const g=new THREE.Group(); g.position.set(DK.x1,(DK.floor+DK.quay)/2,s*80); dockG.add(g);
    box(82,DK.quay-DK.floor,11,steel,41,0,0,g,2);
    box(82,7,15,toon(0x4A5058),41,(DK.quay-DK.floor)/2-5,0,g,false);      // the walkway on top
    for(let i=1;i<4;i++) box(5,DK.quay-DK.floor-8,15,steel,i*20,0,0,g,false); // ribs
    g.userData.s=s; dockGates.push(g);
  });

  /* the quay furniture: sheds, a pump house, crane rails, bollards, lamps */
  const shed=toon(0x8E9484);
  box(150,44,80,shed,-336,DK.quay+22,314,dockG,2.2);
  
  box(70,64,70,toon(0xB0B4A6),-392,DK.quay+32,318,dockG,2.2);   // pump house
  
  [-1,1].forEach(s=>at(CX,W+240,s*182,15,DK.quay,DK.quay+4,steel));   // crane rails
  const boll=toon(0x4A4E48);
  for(let x=DK.x0+30;x<=DK.x1-20;x+=58){
    cyl(7,9,17,8,boll,x,DK.quay+8,138,dockG,1.2);
    cyl(7,9,17,8,boll,x,DK.quay+8,-138,dockG,1.2);
  }
  const crateMat=toon(0xC9A24B);
  crates=[];
  for(let i=0;i<SC.crates;i++){
    const side=i%2?1:-1, j=(i/2)|0, col=j%3, row=(j/3)|0;
    const e=box(36,24,34,crateMat,-300+col*56,DK.quay+12+row*26,212+(i%2)*40+col*8,dockG);
    e.visible=false;e.userData.rest=DK.quay+12+row*26;crates.push(e);
  }
  /* work lights on the quay — the yard runs at night.
     A lamp on a pole is a dot. A lamp that puts a pool of light on the ground
     under it is a lamp: the yard reads as lit rather than as decorated, and
     the pools are what tell you the apron is concrete and not a void. */
  yardLamps=[]; lightPools=[];
  const poolMat=new THREE.MeshBasicMaterial({color:0xFFDDA0,transparent:true,opacity:0,
    depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,fog:false});
  scene.userData.poolMat=poolMat;
  [[-336,214],[210,214],[-60,214],[-330,-246],[-60,-246],[210,-246],[-430,60],[300,80]].forEach(([x,z])=>{
    cyl(3,4,74,6,steel,x,DK.quay+37,z,dockG,false);
    const l=new THREE.Mesh(new THREE.SphereGeometry(7,8,7),
      new THREE.MeshBasicMaterial({color:0xFFE2A6,fog:false,transparent:true,opacity:0}));
    l.position.set(x,DK.quay+76,z); dockG.add(l); yardLamps.push(l);
    const p=new THREE.Mesh(new THREE.CircleGeometry(78,20),poolMat);
    p.rotation.x=-Math.PI/2; p.position.set(x,DK.quay+3.9,z); dockG.add(p); lightPools.push(p);
  });
  /* Festoon lighting down both walls of the dock, and two floods on the floor.
     Half this film happens inside a hole in the ground at night, and the hole
     had no light in it at all: the plating shots were a dark rectangle with
     grey slabs in it, which is not a picture of a ship being built. */
  const fest=new THREE.MeshBasicMaterial({color:0xFFE0A8,fog:false,transparent:true,opacity:0});
  let firstBulb=null;
  for(let x=DK.x0+26;x<DK.x1-10;x+=38) [-1,1].forEach(sd=>{
    const b=new THREE.Mesh(new THREE.SphereGeometry(3.2,7,6),fest);
    b.position.set(x,DK.quay-9,sd*104); dockG.add(b);
    firstBulb=firstBulb||b;
  });
  /* they share one material, so one of them in the lamp list lights them all */
  if(firstBulb) yardLamps.push(firstBulb);
  const floorGlow=new THREE.MeshBasicMaterial({color:0xFFD79A,transparent:true,opacity:0,
    depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,fog:false});
  scene.userData.floorGlow=floorGlow;
  [[DK.x0+90,-1],[DK.x1-130,1]].forEach(([x,sd])=>{
    cyl(3,4,26,6,steel,x,DK.floor+13,sd*92,dockG,false);
    const l=new THREE.Mesh(new THREE.SphereGeometry(5.5,8,7),fest);
    l.position.set(x,DK.floor+28,sd*92); dockG.add(l);
    const p=new THREE.Mesh(new THREE.CircleGeometry(96,20),floorGlow);
    p.rotation.x=-Math.PI/2; p.position.set(x,DK.floor+1.2,sd*46); dockG.add(p);
  });
  /* the sheds are working too, and a lit window says so from further away
     than anything else you can put on a wall */
  shedWins=[];
  const shedWin=new THREE.MeshBasicMaterial({color:0xFFE7B8,fog:false,transparent:true,opacity:0});
  shedWins.push(shedWin);
  for(let i=-2;i<=2;i++){
    const w=new THREE.Mesh(new THREE.PlaneGeometry(20,13),shedWin);
    w.position.set(-336+i*27,DK.quay+26,274); dockG.add(w);
  }
  [[-392,283,0],[-392,283,1]].forEach(([x,z],i)=>{
    const w=new THREE.Mesh(new THREE.PlaneGeometry(22,15),shedWin);
    w.position.set(x+i*26,DK.quay+34,z); dockG.add(w);
  });

  /* ---------- what makes the yard a yard: it never stops ----------
     Everything above is scenery, and scenery on its own is why a four-minute
     build used to look like a photograph. These do not track the deploy at
     all — they run on the wall clock, forever, whatever the stage is doing:
     two trucks on the apron road, three welders working their way down the
     hull, a load swinging under the gantry. */
  trucks=[];
  [[0,1],[.42,-1],[.71,1]].forEach(([ph,dir])=>{
    const g=new THREE.Group(); dockG.add(g);
    box(38,15,17,toon(pick([0xE0A93A,0x2F6E90,0xB03A22])),0,8,0,g,1.4);
    box(15,13,16,toon(0xE8E4DA),16,10,0,g,1.4);
    const hl=new THREE.Mesh(new THREE.SphereGeometry(3.2,6,5),
      new THREE.MeshBasicMaterial({color:0xFFEFC8,fog:false,transparent:true,opacity:0}));
    hl.position.set(24,7,0); g.add(hl);
    g.userData={ph,dir,lamp:hl};
    trucks.push(g);
  });
  /* ---------- people ----------
     The one note the motion study left for itself and never acted on: there is
     nothing in this picture at human scale, so there is nothing to say how big
     she is. A hull two hundred and fifty long is only two hundred and fifty
     long if something the size of a person is standing next to it. They also
     happen to be the cheapest movement in the film — six figures walking a
     quay reads as a working yard from any distance at which you can still see
     the quay. */
  crew=[];
  const HAT=[0xE0A93A,0xE8E4DA,0x2F7F58,0xE0A93A,0x2F6E90,0xE8E4DA];
  const figure=(parent)=>{
    const g=new THREE.Group();
    box(6,11,4.4,toon(0x2E3C48),0,10,0,g,.9);            // body
    box(5.4,3.2,4.6,toon(pick(HAT)),0,17.5,0,g,.9);      // head and hard hat
    const legs=box(5.2,7,4,toon(0x1E242B),0,3.5,0,g,.9);
    (parent||scene).add(g);
    return {g,legs};
  };
  rs(83);
  /* four on the apron, walking their own loops, and two at the dock edge
     looking down into it, which is what people at a dock edge do */
  [[-380,250,.00],[120,250,.31],[-160,-230,.58],[260,-232,.79]].forEach(([x,z,ph])=>{
    const f=figure(dockG);
    f.g.position.set(x,DK.quay+4,z);
    f.g.userData={x,z,ph,walk:true};
    crew.push(f);
  });
  [[-40,132],[190,-134]].forEach(([x,z])=>{
    const f=figure(dockG);
    f.g.position.set(x,DK.quay+4,z);
    f.g.rotation.y=z>0?Math.PI:0;
    f.g.userData={x,z,ph:rnd(),walk:false};
    crew.push(f);
  });

  welders=[];
  for(let i=0;i<3;i++){
    const g=new THREE.Group(); scene.add(g);
    /* the welder himself, kneeling at the seam */
    box(5.6,9,4.2,toon(0x33414E),0,-4,0,g,.9);
    box(5,3,4.4,toon(0xE0A93A),0,2,0,g,.9);
    const arc=new THREE.Mesh(new THREE.SphereGeometry(3,8,7),
      new THREE.MeshBasicMaterial({color:0xEAF6FF,fog:false,transparent:true,opacity:0}));
    g.add(arc);
    /* Small and additive. At twenty units across and a fifth opaque this read
       as a soap bubble hanging off the hull, which is the trouble with using a
       sphere for a glow: you can see where it stops. */
    const glow=new THREE.Mesh(new THREE.SphereGeometry(9,9,8),
      new THREE.MeshBasicMaterial({color:0x9FD4FF,fog:false,transparent:true,opacity:0,
        depthWrite:false,blending:THREE.AdditiveBlending}));
    g.add(glow);
    g.userData={arc,glow,ph:i*2.3,lane:i};
    welders.push(g);
  }
  yardSparks=[];
  for(let i=0;i<24;i++){
    const s=new THREE.Mesh(new THREE.SphereGeometry(1.9,4,3),
      new THREE.MeshBasicMaterial({color:0xFFC24A,fog:false,transparent:true,opacity:0}));
    s.visible=false; scene.add(s); yardSparks.push(s);
  }

  gantry=new THREE.Group(); dockG.add(gantry);
  [-182,182].forEach(dz=>{
    box(15,152,15,steel,DK.x0+16,DK.quay+76,dz,gantry);
    box(15,152,15,steel,DK.x1-20,DK.quay+76,dz,gantry);
  });
  box(W+40,15,17,steel,CX,DK.quay+158,-182,gantry); box(W+40,15,17,steel,CX,DK.quay+158,182,gantry);
  trolley=box(54,24,386,steel,0,DK.quay+140,0,gantry);
  hoist=box(6,86,6,steel,0,DK.quay+90,0,gantry,false);
  hook=box(30,14,30,steel,0,DK.quay+44,0,gantry);
  /* a plate on the hook. The gantry used to travel only when the build's own
     progress moved it, which meant it stood still for whole minutes with a
     bare hook — the single most static object in a picture about work. */
  gantryLoad=box(58,7,40,toon(0x6E7A86),0,DK.quay+30,0,gantry,1.6);
  const bl=new THREE.Mesh(new THREE.SphereGeometry(7,9,7),new THREE.MeshBasicMaterial({color:0xE8402A,fog:false,transparent:true,opacity:0}));
  bl.position.set(DK.x0+16,DK.quay+168,0);gantry.add(bl);gantry.userData.alarm=bl;
  const gl=new THREE.Mesh(new THREE.SphereGeometry(5,8,7),new THREE.MeshBasicMaterial({color:0xFFE2A6,fog:false,transparent:true,opacity:0}));
  gl.position.set(0,DK.quay+150,0);gantry.add(gl);yardLamps.push(gl);
  sparks=[];
  for(let i=0;i<18;i++){
    const s=new THREE.Mesh(new THREE.SphereGeometry(2.8,5,4),new THREE.MeshBasicMaterial({color:0xFFB03A,fog:false}));
    s.visible=false;scene.add(s);sparks.push(s);
  }
}

/* ---------- the repair drone ---------- */
function buildDrone(){
  drone=new THREE.Group(); drone.visible=false; scene.add(drone);
  box(22,9,16,toon(0xB6BCC4),0,0,0,drone,1.6);
  box(9,5,9,toon(0x2A3038),0,6,0,drone,1.4);
  [[-13,9],[13,9],[-13,-9],[13,-9]].forEach(([x,z])=>{
    box(4,4,4,toon(0x5C6670),x,4,z,drone,1.2);
    const r=new THREE.Mesh(new THREE.CircleGeometry(7,12),
      new THREE.MeshBasicMaterial({color:0xF2F0EA,transparent:true,opacity:.55,side:THREE.DoubleSide,fog:false}));
    r.rotation.x=-Math.PI/2;r.position.set(x,7,z);drone.add(r);
  });
  droneEye=new THREE.Mesh(new THREE.SphereGeometry(4.4,9,7),new THREE.MeshBasicMaterial({color:0x2FD07F,fog:false}));
  droneEye.position.set(11,1,0);drone.add(droneEye);
  weldArc=new THREE.Mesh(new THREE.SphereGeometry(6,9,7),
    new THREE.MeshBasicMaterial({color:0xEAF6FF,fog:false,transparent:true,opacity:0}));
  scene.add(weldArc);
  weldLight=new THREE.PointLight(0xBFE4FF,0,340,2); scene.add(weldLight);
}

/* ---------- the rest of the bay ---------- */
function buildBay(){
  /* sailboats */
  rs(23); boats=[];
  const sailMat=new THREE.MeshBasicMaterial({color:0xF6F4EE,side:THREE.DoubleSide});
  const tri=(w,h)=>{const s=new THREE.Shape();s.moveTo(0,0);s.lineTo(w,0);s.lineTo(0,h);s.closePath();return new THREE.ShapeGeometry(s);};
  for(let i=0;i<7;i++){
    const g=new THREE.Group();
    box(26,6,8,toon(0xE8E2D2),0,2,0,g,1.2);
    const m1=new THREE.Mesh(tri(15,34),sailMat); m1.position.set(-6,5,0); g.add(m1);
    const m2=new THREE.Mesh(tri(-13,26),sailMat); m2.position.set(-7,5,0); g.add(m2);
    cyl(.8,.8,36,5,toon(0x8C93A0),-7,22,0,g,false);
    let bx,bz;
    do{ bx=-620+rnd()*2000; bz=300+rnd()*1500; }
    while(Math.hypot(bx-DOCK.x,bz-DOCK.z)<760);      // keep them out of the yard
    g.position.set(bx,0,bz);
    g.userData={a:rnd()*6.283,r:110+rnd()*220,cx:bx,cz:bz,sp:.05+rnd()*.05};
    scene.add(g);boats.push(g);
  }
  /* the tug that walks her out */
  tug=new THREE.Group(); tug.visible=false; scene.add(tug);
  box(56,18,22,toon(0xB03A22),0,7,0,tug,1.8);
  box(24,16,18,toon(0xE8E2D2),-6,24,0,tug,1.8);
  cyl(5,6,16,10,toon(0x2A3038),-20,32,0,tug,1.6);
  box(14,8,26,toon(0x1E242B),16,10,0,tug,1.4);
  /* Alcatraz */
  alcatraz=new THREE.Group(); scene.add(alcatraz);
  /* clouds and birds — the two cheapest things that say "animation" */
  const cloudMat=new THREE.MeshBasicMaterial({color:0xffffff});
  scene.userData.cloudMat=cloudMat; clouds=[];
  rs(5);
  for(let i=0;i<12;i++){
    const g=new THREE.Group();
    for(let j=0;j<5;j++){
      const m=new THREE.Mesh(new THREE.SphereGeometry(62+Math.abs(Math.sin(i*3+j))*54,8,6),cloudMat);
      m.position.set(j*96-190,Math.sin(i+j)*24,Math.cos(i*2+j)*44);m.scale.y=.5;g.add(m);
    }
    g.position.set(-3000+i*560,430+((i*197)%560),-1500-((i*53)%2400));
    g.userData.spd=6+((i*13)%9);
    scene.add(g);clouds.push(g);
  }
  const birdMat=new THREE.MeshBasicMaterial({color:0x2A2622,fog:false,side:THREE.DoubleSide});
  birds=[];
  for(let i=0;i<9;i++){
    const g=new THREE.Group();
    const l=new THREE.Mesh(new THREE.PlaneGeometry(12,2.4),birdMat),r=l.clone();
    l.position.x=-6;r.position.x=6;g.add(l,r);
    g.userData={l,r,ph:i*1.3,r0:280+i*70,y:150+((i*57)%180),sp:.075+(i%3)*.02};
    scene.add(g);birds.push(g);
  }
  /* fog, pouring over the headland and through the gate */
  fogs=[];
  const fogMat=new THREE.MeshBasicMaterial({color:0xF2F0EA,transparent:true,opacity:0,depthWrite:false});
  scene.userData.fogMat=fogMat;
  rs(41);
  for(let i=0;i<8;i++){
    const g=new THREE.Group();
    for(let j=0;j<4;j++){
      const m=new THREE.Mesh(new THREE.SphereGeometry(46+rnd()*34,9,6),fogMat);
      m.position.set(j*74-110,rnd()*14,rnd()*50-25);m.scale.set(1.4,.26,.9);g.add(m);
    }
    /* it comes over the Marin shoulder and lies on the water outside the gate */
    g.position.set(-1750+rnd()*700,i<4?170+rnd()*120:26+rnd()*30,-900+rnd()*1500);
    g.userData={sp:9+rnd()*8};
    g.renderOrder=-2;
    scene.add(g);fogs.push(g);
  }
  /* the buoy at the gate */
  buoy=new THREE.Group(); buoy.position.set(210,0,110); scene.add(buoy);
  const cone=new THREE.Mesh(new THREE.ConeGeometry(16,32,9),toon(0xE2542F));
  cone.position.y=11;buoy.add(cone);outline(cone,2);
  buoyLamp=new THREE.Mesh(new THREE.SphereGeometry(6.5,10,8),new THREE.MeshBasicMaterial({color:0x2FD07F,fog:false}));
  buoyLamp.position.y=36;buoy.add(buoyLamp);buoy.visible=false;

  /* ---------- the bay at night has traffic on it ----------
     Four ferries and a container ship, on straight runs across the bay, lit
     the way a vessel under way is lit: red to port, green to starboard, white
     above. They are small and far off and none of them is the subject of a
     single shot — which is exactly why they are here. A harbour with nothing
     moving on it at four in the morning is a photograph of a harbour. */
  ferries=[];
  const LANES=[
    {a:V3(1500,0,1560),b:V3(-560,0,780),  sp:34, s:1.0},
    {a:V3(-300,0,1750), b:V3(1900,0,2380),sp:26, s:0.8},
    {a:V3(760,0,320),   b:V3(2100,0,1750),sp:30, s:0.9},
    {a:V3(-900,0,-420), b:V3(1400,0,660), sp:44, s:1.7},
    {a:V3(2200,0,900),  b:V3(120,0,1980), sp:22, s:0.7}
  ];
  rs(59);
  LANES.forEach((ln,i)=>{
    const g=new THREE.Group(); scene.add(g);
    const S2=ln.s;
    box(64*S2,13*S2,20*S2,toon(i===3?0x2A3038:0xE8E2D2),0,6*S2,0,g,1.6);
    box(30*S2,17*S2,17*S2,toon(0xF2EEE2),-6*S2,20*S2,0,g,1.6);
    cyl(3.4*S2,4.2*S2,13*S2,8,toon(i===3?0xB03A22:0x2F6E90),-18*S2,33*S2,0,g,1.4);
    /* her lit windows, and the three lights that say which way she is going */
    const wmat=new THREE.MeshBasicMaterial({color:0xFFE7B8,fog:false,transparent:true,opacity:0});
    [1,-1].forEach(sd=>{
      const p=new THREE.Mesh(new THREE.PlaneGeometry(26*S2,5*S2),wmat);
      p.position.set(-6*S2,21*S2,sd*8.7*S2); if(sd<0)p.rotation.y=Math.PI; g.add(p);
    });
    const nav=(c,x,z,y)=>{
      const l=new THREE.Mesh(new THREE.SphereGeometry(2.6*S2,7,6),
        new THREE.MeshBasicMaterial({color:c,fog:false,transparent:true,opacity:0}));
      l.position.set(x*S2,y*S2,z*S2); g.add(l); return l;
    };
    g.userData={...ln,ph:rnd(),win:wmat,
                lights:[nav(0xFF3A2A,4,-11,10),nav(0x2FD07F,4,11,10),nav(0xFFF4E0,-6,0,42)],
                wake:null};
    ferries.push(g);
  });

  /* one aeroplane, very high, crossing on the diagonal. Two lights and a shape
     you can barely resolve — it costs nothing and it makes the sky a place. */
  aircraft=new THREE.Group(); scene.add(aircraft);
  const planeMat=new THREE.MeshBasicMaterial({color:0x2A2622,fog:false});
  box(26,4,5,planeMat,0,0,0,aircraft,false);
  box(6,3,30,planeMat,-2,0,0,aircraft,false);
  aircraft.userData.strobe=new THREE.Mesh(new THREE.SphereGeometry(3.4,7,6),
    new THREE.MeshBasicMaterial({color:0xFFFFFF,fog:false,transparent:true,opacity:0}));
  aircraft.add(aircraft.userData.strobe);

  /* Alcatraz keeps a light, and a light that turns is the cheapest animation
     in the world: one flash every few seconds, from two kilometres away. */
  alcBeam=new THREE.Mesh(new THREE.SphereGeometry(9,10,8),
    new THREE.MeshBasicMaterial({color:0xFFF6D8,fog:false,transparent:true,opacity:0}));
  alcBeam.position.set(1240,74,1420); scene.add(alcBeam);
}

function buildScene(){
  scene=new THREE.Scene();
  /* Pulled in from 8200. Everything past this is fog colour, which is what
     lets the model stop existing somewhere the camera cannot see it stop. */
  scene.fog=new THREE.Fog(0xffffff,1400,7000);
  RAMP=RAMP||ramp();
  plateClip=new THREE.Plane(V3(-1,0,0),0);
  OUTLINE=new THREE.MeshBasicMaterial({color:0x211d1a,side:THREE.BackSide,fog:false});
  OUTLINE_CLIP=new THREE.MeshBasicMaterial({color:0x211d1a,side:THREE.BackSide,fog:false,clippingPlanes:[plateClip]});
  cars=[];carLamps=[];nameDecals=[];relDecals=[];funnelMark=[];
  COLLIDERS=[];nightLamps=[];ferries=[];trucks=[];welders=[];cityWinMats=[];
  shedWins=[];lightPools=[];towerBlinks=[];shipWins=[];deckFloods=[];
  yardSparks=[];crew=[];

  /* sky — hard bands, the way a background painter would do it */
  skyMat=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,
    uniforms:{zen:{value:PC.zen},hor:{value:PC.hor},sun:{value:PC.sun},
              sunDir:{value:V3(0,.1,1).normalize()},dusk:{value:0},stars:{value:1},
              moonDir:{value:MOON.clone()},moon:{value:1},tw:{value:0}},
    vertexShader:`varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`
      uniform vec3 zen,hor,sun,sunDir,moonDir; uniform float dusk,stars,moon,tw; varying vec3 vD;
      void main(){
        float h=clamp(vD.y*2.6+0.06,0.,1.);
        float b=floor(pow(h,0.7)*6.0)/6.0;              // six flat bands
        vec3 c=mix(hor,zen,b);
        // stars, banded onto a grid so they hold still and stay cartoon
        // A star used to be a whole grid cell, which at this focal length is a
        // one-degree SQUARE — the sky read as litter. Round it off inside the
        // cell and make the grid fine enough that a star is a point.
        vec3 gs=vD*232.0; vec3 cell=floor(gs); vec3 sub=fract(gs)-0.5;
        float sh=fract(sin(dot(cell,vec3(12.9898,78.233,37.719)))*43758.5453);
        float sb=fract(sin(dot(cell,vec3(39.346,11.135,83.155)))*24634.6345);
        // twinkle: each star on its own phase, and a third of them bright
        float tk=0.62+0.38*sin(tw*1.7+sb*39.0);
        float dot2=smoothstep(0.36,0.05,length(sub));
        c+=vec3(0.85,0.88,1.0)*step(0.9948,sh)*dot2*(0.55+1.1*sb)*tk*stars*smoothstep(0.0,0.30,vD.y);
        // the moon, and the sky it lights. Without a light source you can point
        // the lens at, a night exterior is a black rectangle with lamps in it.
        float md=max(dot(normalize(vD),moonDir),0.);
        c=mix(c,mix(zen,vec3(0.42,0.48,0.62),0.55),smoothstep(0.86,1.0,md)*0.30*moon);
        c+=vec3(0.30,0.34,0.46)*pow(smoothstep(0.9915,1.0,md),1.7)*moon;
        c+=vec3(0.94,0.96,1.0)*smoothstep(0.99948,0.99962,md)*moon;
        float d=max(dot(normalize(vD),normalize(sunDir)),0.);
        float ring=smoothstep(0.986,0.9885,d);          // a hard halo, not a bloom
        c=mix(c,sun,ring*0.5*(0.4+0.6*dusk));
        c=mix(c,mix(hor,sun,0.5),smoothstep(0.93,0.999,d)*0.40*dusk);
        // the first light lying along the eastern horizon, before the disc
        c=mix(c,sun,smoothstep(0.55,1.0,d)*smoothstep(0.16,-0.02,vD.y)*0.30*dusk);
        // a couple of long cirrus bands, banded like everything else
        float s=sin(vD.y*46.0+vD.x*3.0)*0.5+0.5;
        c=mix(c,mix(c,sun,0.5),step(0.86,s)*0.30*smoothstep(0.02,0.3,vD.y));
        gl_FragColor=vec4(c,1.);
      }`});
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(11000,32,18),skyMat));

  sunDisc=new THREE.Mesh(new THREE.CircleGeometry(1,44),new THREE.MeshBasicMaterial({color:PC.sun,fog:false}));
  scene.add(sunDisc);
  sunRing=new THREE.Mesh(new THREE.RingGeometry(1.18,1.30,52),
    new THREE.MeshBasicMaterial({color:PC.sun,fog:false,transparent:true,opacity:.5}));
  scene.add(sunRing);

  /* light: one key, one rim, generous ambient — cartoons are lit flat */
  ambLight=new THREE.AmbientLight(0xffffff,1.6); scene.add(ambLight);
  keyLight=new THREE.DirectionalLight(0xffffff,2);
  keyLight.castShadow=true; keyLight.shadow.mapSize.set(2048,2048);
  const sc=keyLight.shadow.camera; sc.left=-420;sc.right=420;sc.top=340;sc.bottom=-160;sc.near=1;sc.far=1800;
  keyLight.shadow.bias=-.0016;
  scene.add(keyLight,keyLight.target);
  rimLight=new THREE.DirectionalLight(0xffffff,.9);
  rimLight.position.set(-300,180,-500); scene.add(rimLight);

  buildWater();
  const landMat=new THREE.MeshToonMaterial({color:PC.land,gradientMap:RAMP,vertexColors:true,flatShading:true});
  scene.userData.terrainMat=landMat;
  /* bigger than they were, and drowned at the rim — see `terrain`. The old
     planes ended just outside the widest shot, which is why the establisher
     had a coastline that stopped in mid-air on both sides. */
  terrain(-2700,400,4600,4800,62,62,hN,landMat,{xl:-4300,xh:-800,zl:-1600,zh:2400});
  terrain(2500,1050,4800,5600,62,68,hS,landMat,{xl:800,xh:4300,zl:-1350,zh:3300});
  terrain(1180,1460,480,380,20,16,hAlc,landMat);
  buildBackdrop();
  buildBridge();
  buildCity();
  buildYard();
  buildShip();
  buildDrone();
  buildBay();
  COLLIDERS.push(shipG,dockG,scene.userData.bridge);
  /* Alcatraz's buildings, once the rock is there */
  box(120,34,52,toon(0xE0DCCE),1180,32,1460,alcatraz,2.2);
  cyl(8,10,40,10,toon(0xF2EEE2),1240,50,1420,alcatraz,2);
}

/* ---------- the shot list ----------
   Each entry starts at a beat (optionally a fraction into it) and runs until
   the next one. Hard cuts, no dissolves. Entries with `req` only exist in the
   scenarios that actually have that beat. */
function shots(){
  const S_=(id,f)=>AT[id]?AT[id].s+AT[id].d*(f||0):0;
  const W=(x,y,z)=>shipG.localToWorld(V3(x,y,z));
  const D=(x,y,z)=>dockG.localToWorld(V3(x,y,z));
  const list=[
    /* night over the strait: the yard lit, the city lit, the sky not yet */
    {t:S_("accept"),n:"EST · THE STRAIT",fov:40,
     f:k=>({p:V3(-1980+120*eio(k),540-46*eio(k),1980-150*eio(k)),t:V3(-150,150,560)})},
    {t:S_("clone"),n:"CRANE DOWN · CARGO",fov:36,
     f:k=>({p:D(-560,400-250*eio(k),-320+40*eio(k)),t:D(-250,40,190)})},
    {t:S_("detect"),n:"CU · SURVEY",fov:26,
     f:k=>({p:D(64-34*k,40,258),t:D(-300,28,236)})},
    /* along the empty dock, past the blocks she will be built on */
    /* Over the coping, not level with it: at 36 the near wall filled the lower
       half of the frame and the empty dock the shot is about was behind it. */
    {t:S_("plan"),n:"TRUCK · THE AGENT READS",fov:36,
     f:k=>({p:D(-244+130*eio(k),82,-176),t:D(90,-30,0)})},
    /* down on the floor of the dock, inside it, as the keel is laid */
    {t:S_("render"),n:"LOW · THE KEEL",fov:46,
     f:k=>({p:D(216-18*k,-2,42),t:D(-150,-28,0)})},
    /* Backed off from where the study had it. It was a tight track designed to
       flash past in three seconds; it is now a shot the film may have to sit
       in for four minutes, and at that range the frame was two grey slabs. */
    {t:S_("build",.26),n:"TRACK · PLATING",fov:36,
     f:k=>({p:D(-320+460*k,76,-198),t:D(-130+330*k,6,0)})},
    {t:S_("build",.80),n:"3/4 · SUPERSTRUCTURE",fov:34,
     f:k=>({p:D(-334+36*eio(k),94,-232),t:D(-88,16,0)})},
    /* the failure, and the three shots it earns */
    {t:FAIL_T-0.35,req:"repair",n:"SNAP · THE BREAK",fov:k=>lerp(46,28,eio(cl(k*3))),shake:1,noalt:true,
     f:k=>({p:D(190+150*(1-eio(cl(k*3))),44,-146-40*(1-eio(cl(k*3)))),t:D(26,22,0)})},
    {t:S_("repair",.10),req:"repair",n:"CU · THE AGENT ARRIVES",fov:34,
     f:k=>({p:D(262-26*k,54,-140),t:D(46,34,12)})},
    {t:S_("repair",.50),req:"repair",n:"WELD · SPARKS",fov:30,
     f:k=>({p:D(140+190*eio(k),24+34*eio(k),-118-46*eio(k)),t:D(22,20,0)})},
    /* she is taken back to the keel before she is built again — that is what a
       rebuild is, and it deserves the shot that says so */
    {t:S_("repair",.78),req:"repair",n:"HIGH · BACK TO THE KEEL",fov:38,
     f:k=>({p:D(424-34*eio(k),188-16*eio(k),-192),t:D(-40,-16,0)})},
    {t:S_("rebuild",.10),req:"rebuild",n:"TRACK · PLATING AGAIN",fov:36,
     f:k=>({p:D(-320+460*k,76,-198),t:D(-130+330*k,6,0)})},
    {t:S_("upload"),n:"HIGH · LAYERS LANDING",fov:38,
     f:k=>({p:D(452-40*eio(k),206-46*eio(k),-176+30*eio(k)),t:D(-46,16,0)})},
    /* on the wall of the dock, below the coping: her name, the mark, the ensign */
    {t:S_("release"),n:"HERO · SEALED",fov:36,
     f:k=>({p:D(322-44*eio(k),34,-146),t:D(-62,16,0)})},
    /* the gates go back and the sea comes in: stay outside them and watch */
    {t:S_("flood"),n:"WIDE · LAUNCH",fov:48,
     f:k=>({p:D(316+170*eio(k),20+58*eio(k),-22-20*eio(k)),t:D(-30,20,0)})},
    {t:S_("place",.13),n:"TRACK · UNDER WAY",fov:34,follow:true,
     f:(k,s,d)=>({p:s.clone().add(V3(-d.x*450+d.z*190,132,-d.z*450-d.x*190)),t:s.clone().add(V3(0,40,0))})},
    {t:S_("place",.40),n:"AERIAL · APPROACH",fov:32,follow:true,
     f:(k,s,d)=>({p:s.clone().add(V3(-d.x*300,262-60*k,-d.z*300+430)),t:s.clone().add(V3(0,34,-300))})},
    {t:S_("place",.80),n:"LOW · THE SPAN",fov:46,follow:true,
     f:(k,s)=>({p:V3(s.x+300,24,s.z+440),t:V3(s.x+30,BR.deck+20,s.z-150)})},
    /* she is coming at us now, and the sun is coming up behind her */
    {t:S_("verify"),n:"PASS · THE GATE",fov:40,follow:true,
     f:(k,s)=>({p:V3(s.x+130,30,s.z-430-90*k),t:V3(s.x,96,s.z+170)})},
    {t:S_("live"),n:"THROUGH · LOOKING BACK",fov:34,follow:true,
     f:(k,s)=>({p:V3(178-70*eio(k),42+78*eio(k),s.z-460),t:V3(s.x-10,96,s.z+240)})},
    /* the last shot: crane up, dolly seaward, and keep looking back at the
       gate — the sun comes up through the span with her on the glitter */
    /* `noalt`: the film does not go looking for another angle on this one.
       It is the last frame, the endcard sits in it, and the sun coming up
       through the span with her on the glitter is the shot the whole thing is
       for — re-framing it every nine seconds would be re-framing the ending. */
    {t:S_("live",.24),n:"PULL BACK · SUNRISE",fov:k=>lerp(30,46,eio(k)),noalt:true,
     f:k=>({p:V3(70+90*eio(k),96+230*eio(k),-1450-1750*eio(k)),t:V3(0,120+50*eio(k),160)})}
  ].filter(s=>!s.req||AT[s.req]);
  list.sort((a,b)=>a.t-b.t);
  return list;
}
let SHOTS=[];
/** The deploy's own log lines, or null while nothing has been handed over. */
let LIVE=null;
function shotAt(t){
  let i=0; while(i+1<SHOTS.length&&SHOTS[i+1].t<=t) i++;
  return {s:SHOTS[i],i,k:cl((t-SHOTS[i].t)/Math.max(.001,((SHOTS[i+1]?SHOTS[i+1].t:TOTAL)-SHOTS[i].t)))};
}

/* ---------- how the camera behaves when the deploy is slow ----------
   A shot used to be a MOVE parameterised by story time. A stage that took four
   minutes was therefore a move that finished in about three seconds and then a
   lens holding perfectly still for three minutes and fifty-seven. Two changes,
   and between them they are most of the answer:

   1. THE MOVE RUNS ON WALL TIME. It reads at the same speed whatever the
      deploy is doing, and when it is over the shot keeps drifting — a slow
      orbit, a slow push — instead of parking on its last frame.

   2. A SHOT HAS A LENGTH. When it runs out and the stage has not, the film
      cuts to another angle on the same subject. A long stage becomes an
      edited sequence, which is what a long stage is in any film ever made.

   The alternates are derived, not written: the master's own target, seen from
   a yaw, a height and a distance off it. Twenty shots times five hand-written
   alternates is a hundred framings nobody would ever check; five numbers and
   the collision pass below is a hundred framings that cannot go through a
   wall. */
const ALTS=[
  {yaw:0,     lift:1,    dist:1,    fov:0},
  {yaw:0.92,  lift:1.36, dist:0.76, fov:-7},
  {yaw:-1.24, lift:0.62, dist:1.20, fov:5},
  {yaw:2.34,  lift:1.70, dist:1.48, fov:-3},
  {yaw:-2.58, lift:0.88, dist:0.90, fov:9}
];
const MOVE_LEN=6.4;   // wall seconds a shot's own move takes
const SHOT_LEN=9.0;   // ...and how long it stays up before the film re-angles

/* Roughly how high the ground is under a point — enough to keep a lens out of
   it, which is all this is for. Inside the yard the ground is the dock, and
   the dock is a hole, so it is the floor of the hole. */
function groundAt(x,z){
  const rel=new THREE.Vector2(x-DOCK.x,z-DOCK.z);
  const lx=rel.x*HU.x+rel.y*HU.z, lz=-rel.x*HU.z+rel.y*HU.x;
  if(lx>DK.x0-40&&lx<DK.x1+20&&Math.abs(lz)<DK.hw+10) return DK.floor;      // in the hole
  if(lx>-500&&lx<400&&Math.abs(lz)<400) return DK.quay;                     // on the apron
  /* Outside the strait proper, trust the terrain. Inside it, do not: both
     height functions carry noise that would invent a hill in open water and
     push the low shots up off the surface, which is where they belong. */
  let g=-30;
  if(x<-1150) g=Math.max(g,hN(x,z));
  if(x>1150)  g=Math.max(g,hS(x,z));
  return g;
}
const _ray=new THREE.Raycaster();
const _dir=V3(0,0,0), _cand=V3(0,0,0), _bb=V3(0,0,0);
const _fwd=V3(0,0,0), _rt=V3(0,0,0), _up=V3(0,0,0), _UP=V3(0,1,0), _side=V3(0,0,0);
/* How much of the frame a thing would take up, rather than how big it is.
   The first version of this asked whether the object was thick — which let a
   gantry leg fifteen units wide sit forty units from the lens and eat a third
   of the picture, while making the camera flinch from a bollard two hundred
   metres away. What matters is angular size: `minDim / distanceFromLens`. A
   girder at arm's length is in the way; the same girder across the bay is the
   background. */
function girth(o){
  if(!o.isMesh||!o.geometry) return 0;
  /* three does not skip hidden meshes when it raycasts, and the ship spends
     the first half of the film hidden by a flag on her parent — an unbuilt
     hull that still stops the camera is a lens backed into a wall for a
     minute and a half. */
  for(let p=o;p;p=p.parent) if(!p.visible) return 0;
  const m=o.material;
  if(!m||m.transparent||m.opacity<1||m.depthWrite===false) return 0;
  const g=o.geometry;
  if(!g.boundingBox) g.computeBoundingBox();
  g.boundingBox.getSize(_bb);
  return Math.min(_bb.x*o.scale.x,_bb.y*o.scale.y,_bb.z*o.scale.z);
}
const IN_THE_WAY=.11;   // ~6 degrees of the frame, which is enough to notice
const ELBOW=44;         // and how much room the lens wants on either side of it
function crowded(p){
  /* Nothing in the line to the subject and still ruining the shot: a gantry
     leg ten units to the left of the glass takes a third of the frame and the
     sight-line test above never sees it, because it is not on the sight line.
     So: four short rays out of the lens, and if any of them hits something
     inside arm's length, this is not a place to put a camera. */
  /* Left, right and up. Not down: the lens is often a few units off a quay or
     a dock floor, on purpose, and the ground is already handled by groundAt. */
  for(let i=0;i<3;i++){
    _side.copy(i<2?_rt:_up).multiplyScalar(i===1?-1:1);
    _ray.set(p,_side); _ray.near=0; _ray.far=ELBOW;
    const hits=_ray.intersectObjects(COLLIDERS,true);
    for(const h of hits) if(girth(h.object)>=3) return true;
  }
  return false;
}
function clear(p,tgt){
  _dir.copy(p).sub(tgt);
  const far=_dir.length();
  if(far<1) return true;
  _ray.set(tgt,_dir.multiplyScalar(1/far));
  _ray.near=10; _ray.far=far-3;      // whatever we are looking AT is not in the way
  const hits=_ray.intersectObjects(COLLIDERS,true);
  for(const h of hits){
    const g=girth(h.object);
    if(g<3) continue;                             // rigging, rails, cables
    const lens=far-h.distance;                    // how far it is from the LENS
    if(lens<14||g/Math.max(6,lens)>IN_THE_WAY) return false;
  }
  _fwd.copy(tgt).sub(p).normalize();
  _rt.crossVectors(_fwd,_UP).normalize();
  _up.crossVectors(_rt,_fwd).normalize();
  return !crowded(p);
}
/* Where to look from when the first choice is inside something. Each entry is
   a yaw off the master and a lift as a fraction of the distance: step round,
   then step up, then step round further and higher — which is what an operator
   does when there is a gantry leg in the shot. */
const DODGE=[[0,0],[0,.20],[.42,.14],[-.42,.14],[.85,.34],[-.85,.34],[0,.62],[1.7,.5]];
let DODGEI=0, DODGET=-1;
function dodgeTo(i,p,tgt){
  if(!i) return p;
  const [yaw,lift]=DODGE[i];
  const dx=p.x-tgt.x, dz=p.z-tgt.z, dy=p.y-tgt.y;
  const rad=Math.hypot(dx,dz), a=Math.atan2(dz,dx)+yaw;
  p.set(tgt.x+Math.cos(a)*rad, tgt.y+dy+Math.hypot(rad,dy)*lift, tgt.z+Math.sin(a)*rad);
  const f=groundAt(p.x,p.z)+16;
  if(p.y<f) p.y=f;
  return p;
}
/**
 * Put the lens somewhere it can actually see from.
 *
 * Two failures, both of which this film had and both of which read as a bug
 * rather than a style: the camera underground — a shot that cranes down
 * through a hillside — and the camera behind something, so the frame is one
 * flat grey plane a foot from the glass. This is also what makes the derived
 * alternate angles safe to generate rather than hand-check: a framing that
 * cannot see its own subject is simply never one of the ones offered.
 *
 * Choosing costs eight raycasts against a few hundred meshes, so the choice is
 * made on a tenth-of-a-second cadence and then held. That is not only cheaper:
 * two candidates a hair apart, re-decided every frame, make the lens flicker
 * between them, and the world does not move fast enough for the answer to go
 * stale in a tenth of a second.
 */
/* Nothing worked: come in to just this side of whatever it is, which is at
   least a picture of something rather than of the inside of it. */
function pullIn(p,tgt){
  _dir.copy(p).sub(tgt);
  const far=_dir.length(); if(far<1) return p;
  _dir.multiplyScalar(1/far);
  _ray.set(tgt,_dir); _ray.near=10; _ray.far=far;
  const hits=_ray.intersectObjects(COLLIDERS,true);
  for(const h of hits) if(girth(h.object)>=3){
    p.copy(tgt).addScaledVector(_dir,Math.max(26,h.distance-10));
    break;
  }
  return p;
}
/* ---------- and the clearance the lens keeps whatever it is looking at ----
   The dodge above chooses an ANGLE, once a tenth of a second, out of eight.
   Between two of those choices there is nothing at all stopping the drift —
   which runs every frame — from walking the lens into a gantry leg, and
   nothing stopping the NEXT choice from being a different angle entirely. So
   the film had both halves of the same bug: a lens that touched things, and a
   lens that jumped when it did.

   This is the other half of the fix. It is a soft shell: a push away from
   anything inside CLEARANCE, growing as the gap closes, so it reads as the
   lens easing off a wall rather than as hitting one. Five probes, on the
   dodge's own cadence — down is not one of them, because the ground is
   already handled and a low shot over a quay is on purpose. */
const CLEARANCE=34;
const PROBE=[V3(1,0,0),V3(-1,0,0),V3(0,0,1),V3(0,0,-1),V3(0,1,0)];
const _push=V3(0,0,0), _mark=V3(0,0,0);
function repel(p){
  _push.set(0,0,0);
  for(const d of PROBE){
    _ray.set(p,d); _ray.near=0; _ray.far=CLEARANCE;
    const hits=_ray.intersectObjects(COLLIDERS,true);
    for(const h of hits){
      if(girth(h.object)<3) continue;
      _push.addScaledVector(d,-(CLEARANCE-h.distance));
      break;
    }
  }
  /* opposite walls both pushing is a corridor, not a shove: cap it, or the
     lens gets fired out of a dock */
  if(_push.lengthSq()>CLEARANCE*CLEARANCE) _push.setLength(CLEARANCE);
  return _push;
}
function safeCam(p,tgt){
  /* out of the ground first, or every ray below starts by hitting it */
  const floor=groundAt(p.x,p.z)+16;
  if(p.y<floor) p.y=floor;
  if(p.y<4) p.y=4;
  /* and inside the world, so a wide shot never gets far enough out to see the
     model stop */
  const r=Math.hypot(p.x,p.z);
  if(r>4300){ p.x*=4300/r; p.z*=4300/r; }
  if(WALL-DODGET>.1||SHOTW<.05){
    DODGET=WALL;
    /* HYSTERESIS. The angle we are already on wins if it still works. Judged
       fresh on its merits every tenth of a second, two candidates a hair
       apart put the lens on a switch, and a switch between two framings is
       exactly the flinch this had. */
    _cand.copy(p);
    if(DODGEI<0||!clear(dodgeTo(DODGEI,_cand,tgt),tgt)){
      DODGEI=0;
      for(let i=0;i<DODGE.length;i++){
        _cand.copy(p);
        if(clear(dodgeTo(i,_cand,tgt),tgt)){ DODGEI=i; break; }
        if(i===DODGE.length-1) DODGEI=-1;
      }
    }
    _mark.copy(p);
    if(DODGEI>=0) dodgeTo(DODGEI,_mark,tgt); else pullIn(_mark,tgt);
    CAMPUSH.copy(repel(_mark));
  }
  if(DODGEI>=0) dodgeTo(DODGEI,p,tgt); else pullIn(p,tgt);
  p.add(CAMPUSH);
  const f=groundAt(p.x,p.z)+14; if(p.y<f) p.y=f;
  if(p.y<4) p.y=4;
  return p;
}

/* ---------- frame ---------- */
let TT=0,LASTCUT=-1,HOLDING=false,ALTI=0,SLATED=false;
/* Where the lens actually is, as opposed to where the shot wants it. See the
   note at the spring, down in the camera block. */
const CAMPUSH=V3(0,0,0), CAMP=V3(0,0,0), CAMLA=V3(0,0,0);
let CUT=true;
const LAG_P=.34;    // seconds for the lens to close on its mark
const LAG_T=.14;    // ...and on what it is pointed at
const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
const _v=V3(0,0,0);
function step(t){
  /* story time is t; TT is the clock on the wall, which does not stop when the
     story does. Everything alive rather than progressing hangs off TT — see
     the note on the two clocks at the top. */
  NOW=t; TT=reduce?0:WALL;
  const bp=buildProgress(t);
  const failing=AT.repair?(t>=FAIL_T&&t<S("rebuild")):false;
  /* the bang: a hard envelope in the first two seconds after the break */
  const bang=AT.repair?Math.exp(-Math.max(0,t-FAIL_T)*2.1)*(t>=FAIL_T?1:0):0;
  const fire=AT.repair?cl(seg(t,FAIL_T,FAIL_T+.6)-pr("repair",.20,.42,t)):0;
  const smog=AT.repair?cl(seg(t,FAIL_T,FAIL_T+.5)-pr("repair",.48,.72,t)):0;
  palette(t);

  /* sky, sun, light */
  /* the sun comes up in the east — over the bay, behind the span. Below the
     horizon it is simply hidden by the water, which is what a horizon is. */
  const sunDir=V3(.30,SUNEL,1).normalize();
  skyMat.uniforms.sunDir.value.copy(sunDir);
  skyMat.uniforms.dusk.value=GOLD;
  skyMat.uniforms.stars.value=NIGHT;
  skyMat.uniforms.moon.value=NIGHT;
  skyMat.uniforms.tw.value=TT;
  const sp=sunDir.clone().multiplyScalar(7600);
  const sr=lerp(300,700,GOLD);
  sunDisc.position.copy(sp); sunDisc.scale.setScalar(sr); sunDisc.quaternion.copy(camera.quaternion);
  sunRing.position.copy(sp).multiplyScalar(.999); sunRing.scale.setScalar(sr); sunRing.quaternion.copy(camera.quaternion);
  sunRing.material.opacity=.14+.44*GOLD;
  sunDisc.material.color.copy(PC.sun); sunRing.material.color.copy(PC.sun);
  scene.fog.color.copy(PC.hor).lerp(PC.water,.25);
  const wu=waterMat.uniforms;
  wu.fogColor.value.copy(scene.fog.color);
  wu.c1.value.copy(PC.water);
  wu.c2.value.copy(PC.water2).lerp(PC.hor,.42);
  wu.foam.value.copy(PC.foam);
  wu.sun.value.copy(PC.sun);
  wu.time.value=TT; wu.dusk.value=GOLD; wu.moon.value=NIGHT;
  /* The key used to follow the sun and nothing else, and for most of this
     film the sun is below the horizon — so two thirds of it was lit by ambient
     alone, which is to say by nothing: flat, shadowless and nearly black. It
     follows the moon instead until the sun is up to take over. */
  keyLight.color.copy(PC.sun).lerp(new THREE.Color(0xffffff),.35)
    .lerp(new THREE.Color(0xA8BEE6),NIGHT*.85);
  keyLight.intensity=lerp(PN.key,1.05,NIGHT)*(failing?.55:1);
  ambLight.intensity=PN.amb;
  /* the rim is the moon while it is night and the sky once it is not */
  rimLight.color.copy(PC.zen).lerp(new THREE.Color(0xC8D8FF),.5+.35*NIGHT);
  rimLight.intensity=.9+.5*NIGHT;
  rimLight.position.copy(MOON).multiplyScalar(900).add(shipG.position);
  scene.userData.orange.color.copy(PC.ggo);
  scene.userData.dark.color.copy(PC.ggo).multiplyScalar(.62);
  scene.userData.terrainMat.color.copy(PC.land);

  scene.userData.cityMat.color.copy(PC.city);
  scene.userData.cityMat2.color.copy(PC.city).multiplyScalar(.82);
  scene.userData.funnelMesh.material.color.copy(PC.ggo);
  splash.forEach(e=>e.material.color.copy(PC.foam));
  /* cloud that is 55% white against a night sky is a cut-out. Under the moon
     they are barely lighter than the sky they are in. */
  scene.userData.cloudMat.color.copy(PC.hor).lerp(new THREE.Color(0xffffff),.55*(1-NIGHT*.62));
  scene.userData.fogMat.opacity=.16+.34*GOLD;
  carLamps.forEach(l=>l.material.opacity=NIGHT*.85);
  yardLamps.forEach(l=>l.material.opacity=NIGHT*.9);
  nameDecals.forEach(d=>d.material.color.setScalar(lerp(.62,1,1-NIGHT)));
  scene.userData.backdrop.material.color.copy(PC.land).lerp(PC.hor,.55);
  wu.night.value=NIGHT;
  wu.lights.value.setHex(0xFFCE86).lerp(PC.foam,.25);

  /* ---------- after dark ----------
     Most of this film happens at night, and the first cut of it had a night
     that was a dark blue photograph: one flat sheet of water, a skyline
     silhouette with a single opacity on all of its windows, and nothing at all
     going anywhere. Everything from here to the end of this block exists to
     say the place is inhabited while the deploy is thinking. */
  cityWinMats.forEach((m,j)=>{
    /* each bank on its own slow breath, and one of them stuttering, because a
       city block where everything dims together is one lamp with a big shade */
    const f=.62+.38*Math.sin(TT*(.21+j*.045)+j*2.1);
    const stut=j===2?(Math.sin(TT*1.7)>.86?.35:1):1;
    m.opacity=NIGHT*.92*f*stut;
  });
  if(cityLights) cityLights.material.opacity=NIGHT*.85;
  lightPools.forEach(p=>p.material.opacity=NIGHT*.20);
  scene.userData.floorGlow.opacity=NIGHT*.26;
  shedWins.forEach(m=>m.opacity=NIGHT*.85);
  shipWins.forEach(m=>m.opacity=NIGHT*.8*(house.visible?1:0));
  deckFloods.forEach(l=>l.material.opacity=NIGHT*.9*(house.visible?1:0));
  towerBlinks.forEach(b=>{
    const x=(TT*.62+b.ph)%1;
    b.m.material.opacity=NIGHT*(x<.16?1:x<.3?.15:0);
  });
  if(alcBeam){
    /* one flash every four seconds or so, from two kilometres away */
    const x=(TT*.28)%1;
    alcBeam.material.opacity=NIGHT*Math.pow(Math.max(0,Math.sin(x*Math.PI*2)),9)*.95;
  }
  /* the aeroplane. A long crossing, then a long absence, so it is a thing you
     notice once rather than a thing that circles. */
  if(aircraft){
    const cyc=(TT/86)%1, on=cyc<.62;
    aircraft.visible=on&&NIGHT>.05;
    if(aircraft.visible){
      const q=cyc/.62;
      aircraft.position.set(lerp(-3400,3600,q),980+Math.sin(q*3)*40,lerp(1900,-900,q));
      aircraft.rotation.y=-Math.atan2(-2800,7000)+Math.PI;
      aircraft.userData.strobe.material.opacity=((TT*1.4)%1)<.09?1:0;
    }
  }
  /* the ferries, on their runs. They are the only things in the picture that
     move at a constant speed in a straight line, which is what makes them
     read as traffic and not as weather. */
  ferries.forEach((g,j)=>{
    const d=g.userData;
    const cyc=(TT*d.sp/d.a.distanceTo(d.b)+d.ph)%2;
    const back=cyc>1, q=back?2-cyc:cyc;
    g.position.lerpVectors(d.a,d.b,q);
    g.position.y=Math.sin(TT*1.3+j)*1.4;
    g.rotation.y=Math.atan2(-(back?d.a.z-d.b.z:d.b.z-d.a.z),(back?d.a.x-d.b.x:d.b.x-d.a.x));
    g.rotation.z=Math.sin(TT*1.6+j*2)*.035;
    d.win.opacity=NIGHT*.85;
    d.lights.forEach(l=>l.material.opacity=NIGHT*.95);
  });

  /* the yard */
  const cn=Math.floor(crates.length*eo(pr("clone")));
  crates.forEach((e,i)=>{
    e.visible=i<cn;
    if(e.visible){const k=eo(cl((cn-i)/1.6));e.scale.set(1,lerp(1.5,1,k),1);e.position.y=e.userData.rest+130*(1-k);}
  });

  /* assembly */
  const plate=seg(bp,.26,1), bowX=-124+254*plate;
  hullParts.forEach(e=>e.visible=plate>.01);
  nameDecals.forEach(d=>d.visible=plate>.6);
  hullParts[0].material.color.setHex(failing?0x6E3A2E:0x2E3C48);
  keel.visible=pr("render",.15,1)>.02;
  keel.scale.x=Math.max(.02,eo(pr("render",.15,1)));
  keel.position.x=-112+100*keel.scale.x;
  const ribP=seg(bp,.02,.40);
  ribs.forEach((e,i)=>{
    const k=eo(seg(ribP,i/10,(i+1)/10));
    /* a frame is scaffolding: once the plating has reached it, it is inside
       her, and drawing it through her sides is the caterpillar again */
    e.visible=k>.05&&(plate<.01||e.position.x>bowX-6);
    e.scale.y=Math.max(.05,k); e.position.y=-16+22*k;
  });
  const hk=eo(seg(bp,.50,.68)),fk=eo(seg(bp,.68,.86));
  const pop=k=>k<1?1+Math.sin(cl((k-.75)/.25)*Math.PI)*.12:1;
  house.visible=hk>.02; house.position.y=31+86*(1-hk); house.scale.y=pop(hk);
  funnel.visible=fk>.02; funnel.position.y=96*(1-fk); funnel.scale.y=pop(fk);
  lifeboat.visible=fk>.9;
  const mk=eo(pr("release",.1,.7));
  mast.visible=mk>.02; mast.scale.y=Math.max(.05,mk);
  flagPole.visible=mk>.4; flag.visible=mk>.8;
  relDecals.forEach(d=>d.material.opacity=eo(pr("release",.25,.9)));
  if(flag.visible){
    flag.position.set(-108+Math.sin(TT*3)*1.5,58,0);
    flag.rotation.y=Math.sin(TT*2.4)*.34;
    const p=flag.geometry.attributes.position;
    for(let i=0;i<p.count;i++){const u=(p.getX(i)+15)/30;p.setZ(i,Math.sin(TT*7-u*4)*2.6*u);}
    p.needsUpdate=true;
  }
  if(radarBar) radarBar.rotation.y=TT*1.5;
  const up=pr("upload"),n=bays.length;
  bays.forEach((g,i)=>{
    const k=eo(seg(up,i/n,(i+.8)/n)),drop=g.userData.cached?cl(k*3):k;
    g.visible=drop>.02;
    g.position.y=160*(1-drop);
    g.scale.y=pop(drop);
  });

  /* motion */
  const harb=cl(pr("flood")*.1+pr("place")*.82+pr("verify")*.08,0,1);
  const open=eio(pr("live",0,.94));
  const u=cl((harb<=.12?harb*harb/.24:harb-.06)/.94);
  let pos,tan;
  if(open<=0.0004){ pos=SHIP_PATH.getPointAt(u); tan=SHIP_PATH.getTangentAt(u); }
  else { pos=OPEN_A.clone().lerp(OPEN_B,open); tan=V3(0,0,-1); }
  /* the dock fills first, then the gates swing back: she lifts off the blocks
     when there is enough water under her to lift her, and not before */
  const fl=eio(pr("flood",0,.62));
  const gopen=eio(pr("flood",.55,.98));
  const list=bang*0.12;                                  // she heels when the plate goes
  shipG.position.set(pos.x,lerp(DK.shipY,0,fl)+(fl>.9?Math.sin(TT*1.2)*1.2:0),pos.z);
  shipG.rotation.y=(harb<.004&&open<=0)?HEAD0:Math.atan2(-tan.z,tan.x);
  shipG.rotation.z=(fl>.55?Math.sin(TT*.8)*.02*seg(fl,.55,.9):0)+list;   // no roll on the blocks
  plateClip.normal.set(-1,0,0); plateClip.constant=bowX;
  shipG.updateMatrixWorld();
  plateClip.applyMatrix4(shipG.matrixWorld);
  if(plate>=.999) plateClip.constant=1e7;
  wu.shipPos.value.copy(shipG.position);
  wu.shipDir.value.set(tan.x,tan.z).normalize();
  wu.wake.value=cl((harb>.02&&harb<.999)||open>0?1:0);

  /* the sea is cut out of the dock's footprint until the gates are open, or
     it would be lying inside a dry dock the whole film */
  const level=lerp(DK.floor+3,0,fl);
  dockWater.position.y=level-70;
  dockWater.visible=fl>.015&&gopen<.985;
  dockWater.material.opacity=.95*(1-seg(gopen,.86,.99));
  dockWater.material.color.copy(PC.water);
  wu.dockCut.value=gopen>.92?0:1;
  dockGates.forEach(g=>{g.rotation.y=lerp(g.userData.s*1.42,g.userData.s*Math.PI,gopen);});

  /* the gantry */
  let gx=0;
  if(t<E("clone")) gx=lerp(-330,70,pr("clone"));
  else if(t<E("detect")) gx=-130;
  else if(t<E("plan")) gx=-90+200*Math.sin(pr("plan")*Math.PI*3.2);
  else if(AT.repair&&t>=FAIL_T&&t<S("rebuild")) gx=-124+254*SC.fail.at;
  else if(t<E("render")) gx=0;
  else if(t<(AT.rebuild?E("rebuild"):E("build"))) gx=-124+254*cl(bp);
  else if(t<E("upload")) gx=-56+150*pr("upload");
  else gx=40;
  /* Where the story puts it, plus where it is going anyway. A gantry parked
     with a bare hook is the loudest object in a still frame, and the story
     only moves this thing when the build's own progress moves — which, on a
     four-minute build, is barely. The patrol and the lift cycle are on the
     wall clock and they never stop. */
  const patrol=Math.sin(TT*.207)*52+Math.sin(TT*.079+1.3)*31;
  const busy=(t>E("clone")&&t<E("upload"));
  gx+=busy?patrol:patrol*.3;
  trolley.position.x=gx; hoist.position.x=gx; hook.position.x=gx;
  gantryLoad.position.x=gx;
  /* one lift every eight seconds: down to the deck, hold, up, traverse */
  const lc=(TT*.125)%1;
  const drop=busy?(lc<.4?eio(lc/.4):lc<.6?1:1-eio((lc-.6)/.4)):.15;
  hoist.scale.y=busy?lerp(.42,1,drop):.3;
  hoist.position.y=DK.quay+lerp(128,90,drop);
  hook.position.y=DK.quay+lerp(118,42,drop)+Math.sin(TT*1.6)*1.6;
  gantryLoad.visible=busy&&drop<.94;
  gantryLoad.position.y=hook.position.y-13;
  gantryLoad.rotation.y=Math.sin(TT*.9)*.10;
  gantryLoad.rotation.z=Math.sin(TT*1.25)*.035;
  gantry.userData.alarm.material.opacity=failing?(Math.sin(TT*7)>0?1:.1):0;

  /* ---------- the yard works whether or not the deploy does ----------
     None of this reads the story clock. That is the entire point of it: the
     complaint this film had was that a stage the deploy sits in for four
     minutes was four minutes of a photograph, and the reason was that every
     moving thing in the yard was wired to progress that had stopped. */
  trucks.forEach(g=>{
    const d=g.userData;
    const q=(TT*.028*(d.dir>0?1:.82)+d.ph)%1;
    /* a loop round the apron: down the long side, across the head, back */
    let lx,lz,head;
    if(q<.42){ lx=lerp(-470,330,q/.42); lz=268; head=0; }
    else if(q<.5){ const u=(q-.42)/.08; lx=330; lz=lerp(268,-214,u); head=-Math.PI/2; }
    else if(q<.92){ const u=(q-.5)/.42; lx=lerp(330,-470,u); lz=-214; head=Math.PI; }
    else { const u=(q-.92)/.08; lx=-470; lz=lerp(-214,268,u); head=Math.PI/2; }
    g.position.set(lx,DK.quay+4,lz);
    g.rotation.y=head*d.dir;
    d.lamp.material.opacity=NIGHT*.95;
  });
  /* the welders. Three, working their way along whatever there is to work on,
     arcing in bursts and out of phase with each other. */
  const yardWork=t>S("render")&&t<E("upload")+3&&!failing;
  let arcAt=null;
  welders.forEach((g,j)=>{
    g.visible=yardWork;
    if(!g.visible) return;
    const ph=(TT*.052+j*.37)%1;
    if(plate>.05){
      const lx=lerp(-112,Math.min(bowX-8,118),ph);
      g.position.copy(shipG.localToWorld(V3(lx,j===1?18:34,(j%2?1:-1)*(29+j))));
    }else{
      /* nothing built yet: they are down on the blocks, laying the keel out */
      g.position.copy(dockG.localToWorld(V3(lerp(DK.x0+40,DK.x1-90,ph),DK.blk+5,(j%2?1:-1)*26)));
    }
    const duty=(TT*.17+j*.41)%1;
    const on=duty<.55?(.45+.55*Math.abs(Math.sin(TT*17.3+j*2)))*(1-cl((duty-.46)/.09)):0;
    g.userData.arc.material.opacity=on;
    g.userData.arc.scale.setScalar(.65+on*.8);
    g.userData.glow.material.opacity=on*.55*(.35+.65*NIGHT);
    g.userData.glow.scale.setScalar(.7+on*.7);
    if(on>.5&&!arcAt) arcAt=g.position;
  });
  /* the crew. Walking is a pair of legs scissoring and a body that bobs —
     at this distance that is the whole of animation, and it is enough. */
  crew.forEach((f,j)=>{
    const d=f.g.userData;
    if(d.walk){
      const q=(TT*.055+d.ph)%1, leg=q<.5?q*2:(1-q)*2;
      const span=170;
      f.g.position.x=d.x+(leg-.5)*span;
      f.g.position.y=DK.quay+4+Math.abs(Math.sin(TT*5.4+j))*.8;
      f.g.rotation.y=q<.5?-Math.PI/2:Math.PI/2;
      f.legs.rotation.x=Math.sin(TT*5.4+j)*.55;
    }else{
      /* the two at the edge shift their weight and look about */
      f.g.position.y=DK.quay+4+Math.sin(TT*1.1+j)*.4;
      f.g.rotation.y=(d.z>0?Math.PI:0)+Math.sin(TT*.37+j*2)*.55;
    }
  });
  yardSparks.forEach((s,j)=>{
    s.visible=!!arcAt&&yardWork;
    if(!s.visible) return;
    const q=(TT*1.7+j*.0417)%1, ang=j*2.4;
    s.position.set(arcAt.x+Math.cos(ang)*q*26,arcAt.y+q*13-q*q*30,arcAt.z+Math.sin(ang)*q*22);
    s.material.opacity=(1-q)*.9;
  });

  /* the break: fire, black smoke, plates in the water, a drone that welds */
  const dmg=shipG.localToWorld(V3(bowX-14,34,0));
  fires.forEach((e,i)=>{
    e.visible=fire>.02;
    if(!e.visible)return;
    const a=i*.7,r=14+i*4;
    e.position.set(bowX-6+Math.cos(a)*r*.8,32+Math.abs(Math.sin(TT*4+i))*16,Math.sin(a)*r*.7);
    e.scale.setScalar((.7+.6*Math.abs(Math.sin(TT*6+i*1.3)))*fire);
    e.material.opacity=.92*fire;
  });
  fireGlow.visible=fire>.02;
  if(fireGlow.visible){
    fireGlow.position.set(bowX-6,38,0);
    fireGlow.scale.setScalar((.5+.18*Math.sin(TT*5))*fire);
    fireGlow.material.opacity=.15*fire;
  }
  blackSmoke.forEach((e,i)=>{
    e.visible=smog>.02;
    if(!e.visible)return;
    const k=(TT*.28+i*.0714)%1;
    e.position.set(dmg.x-8+k*30,26+k*180,dmg.z+Math.sin(k*5+i)*22);
    e.scale.setScalar(.5+k*3.4);
    e.material.opacity=.62*(1-k)*smog;
  });
  debris.forEach((e,i)=>{
    const k=seg(t,FAIL_T+i*.06,FAIL_T+1.5+i*.06);
    e.visible=AT.repair&&k>0&&t<S("rebuild");
    if(!e.visible)return;
    const a=i*1.3;
    e.position.set(dmg.x+Math.cos(a)*(20+k*70),Math.max(DK.floor+4,26+38*k-100*k*k),dmg.z+Math.sin(a)*(16+k*54));
    e.rotation.set(k*5+i,k*3,k*4);
  });
  const dr=AT.repair?pr("repair",.06,.94):0;
  drone.visible=dr>0&&dr<1;
  if(drone.visible){
    const inK=eo(seg(dr,0,.14)), outK=eio(seg(dr,.86,1));
    const hover=shipG.localToWorld(V3(bowX+6,52,18));
    const far=shipG.localToWorld(V3(bowX+150,150,190));
    drone.position.copy(far).lerp(hover,inK).lerp(far,outK);
    drone.position.y+=Math.sin(TT*2.2)*3;
    drone.lookAt(dmg.x,dmg.y+6,dmg.z);
    drone.rotation.y+=Math.PI/2;
    droneEye.material.color.setHex(dr<.30?0xFFC63A:0x2FD07F);
  }
  const weld=AT.repair?pr("repair",.34,.74):0;
  const welding=weld>0&&weld<1;
  weldArc.visible=welding;
  if(welding){
    weldLight.color.setHex(0xBFE4FF);
    weldArc.position.copy(dmg);
    const fl2=.5+.5*Math.abs(Math.sin(TT*13));
    weldArc.scale.setScalar(.7+fl2*1.1);
    weldArc.material.opacity=.55+.45*fl2;
    weldLight.position.copy(dmg).setY(dmg.y+14);
    weldLight.intensity=6+9*fl2;
  } else if(fire>.02){
    /* one light does both jobs: orange while she burns, blue while he welds */
    weldLight.color.setHex(0xFF9A3C);
    weldLight.position.copy(dmg).setY(dmg.y+22);
    weldLight.intensity=(9+5*Math.sin(TT*7))*fire;
  } else weldLight.intensity=0;
  sparks.forEach((s,i)=>{
    s.visible=welding||bang>.25;
    if(!s.visible)return;
    const a=i*.9+TT*6, r=(bang>.25?26:12)+30*((TT*1.9+i*.11)%1);
    s.position.set(dmg.x+Math.cos(a)*r,dmg.y+Math.sin(a)*r*.6+((TT*2+i*.3)%1)*18,dmg.z+Math.sin(a*1.7)*r*.5);
    s.material.color.setHex(welding?0xBFE4FF:0xFFB03A);
  });

  /* wake rings and funnel smoke */
  const moving=(harb>.02&&harb<.999)||open>0;
  splash.forEach((e,i)=>{
    e.visible=moving; if(!e.visible)return;
    const p2=pos.clone().addScaledVector(tan,-(i+1)*30);
    e.position.set(p2.x,1.2,p2.z);
    const g=1+i*.5; e.scale.setScalar(g*(1+((TT*.5+i)%1)*.4));
    e.material.opacity=.34*(1-i/6);
  });
  const puff=((pr("place",.7,1)>0)||moving)&&smog<.2;
  smoke.forEach((e,i)=>{
    e.visible=puff; if(!e.visible)return;
    const d=e.userData;
    const k=(TT*.30+i/smoke.length+d.off)%1, sway=Math.sin(k*4.4+i)*30*k;
    const o=shipG.localToWorld(V3(-104,102,0));
    e.position.set(o.x-tan.x*k*195+tan.z*sway,o.y+Math.pow(k,.8)*128+Math.sin(k*7+i)*5,
                   o.z-tan.z*k*195-tan.x*sway);
    e.scale.setScalar((.22+k*3.4)*d.w);
    e.material.opacity=.34*Math.pow(1-k,1.4)*seg(k,0,.06);
  });

  /* the tug walks her out, then peels off */
  const tk=cl(pr("flood",.5,1)*.4+pr("place",0,.30)*.6);
  tug.visible=tk>.02&&tk<.99;
  if(tug.visible){
    /* she is in a 144-wide dock: the tug waits outside the gates and only
       takes station on her quarter once her stern is clear of them */
    const dist=u*PATH_LEN;
    const tp=SHIP_PATH.getPointAt(cl(Math.max(dist+110,500)/PATH_LEN)),
          tt=SHIP_PATH.getTangentAt(cl(Math.max(dist+110,500)/PATH_LEN));
    const off=seg(dist,300,600)*72+eio(seg(tk,.72,1))*260;
    tug.position.set(tp.x+tt.z*off,2+Math.sin(TT*1.6)*1.4,tp.z-tt.x*off);
    tug.rotation.y=Math.atan2(-tt.z,tt.x);
    tug.rotation.z=Math.sin(TT*1.9)*.05;
  }

  buoy.visible=pr("place",0,.08)>.3;
  buoyLamp.visible=pr("verify")>.72&&(Math.sin(TT*3)>-.4);
  beaconLamp.material.color.setHex(0xFFF0B0);
  beaconLamp.visible=NIGHT>.12&&Math.sin(TT*2.2)>-.2;
  keyLight.target.position.copy(shipG.position);
  _v.copy(sunDir).multiplyScalar(1-NIGHT).addScaledVector(MOON,NIGHT).normalize();
  keyLight.position.copy(shipG.position).addScaledVector(_v,900).setY(680);

  /* traffic, clouds, birds, fog, boats */
  const dt=reduce?0:.016;
  cars.forEach(c=>{
    const d=c.userData;
    d.x+=d.dir*d.spd*dt;
    if(d.x>BR.end)d.x=-BR.end; if(d.x<-BR.end)d.x=BR.end;
    c.position.x=d.x;
    d.lamp.position.set(d.x+d.dir*13,BR.deck+16,d.z);
  });
  clouds.forEach(c=>{c.position.x+=c.userData.spd*dt; if(c.position.x>3600)c.position.x=-3600;});
  fogs.forEach(f=>{f.position.x+=f.userData.sp*dt; if(f.position.x>-300)f.position.x=-2100;});
  birds.forEach((b,i)=>{
    const d=b.userData, a=TT*d.sp+d.ph;
    b.position.set(Math.cos(a)*d.r0-260,d.y+Math.sin(TT*.5+i)*16,Math.sin(a)*d.r0-260);
    b.rotation.y=-a+Math.PI/2;
    const f=Math.sin(TT*7+i)*.55;
    d.l.rotation.z=f; d.r.rotation.z=-f;
  });
  boats.forEach((b,i)=>{
    const d=b.userData, a=d.a+TT*d.sp;
    b.position.set(d.cx+Math.cos(a)*d.r,Math.sin(TT*1.4+i)*1.6,d.cz+Math.sin(a)*d.r);
    b.rotation.y=-a;
    b.rotation.z=Math.sin(TT*1.7+i)*.07;
  });

  /* ---------- the camera ---------- */
  const {s,i}=shotAt(t);
  /* the story reached a new shot: hard cut, and the move starts again */
  if(i!==LASTCUT){ LASTCUT=i; SHOTW=0; ALTI=0; SLATED=false; CUT=true; DODGEI=0; }
  /* the shot has outstayed its length and the deploy has not moved on: cut to
     the next angle on the same subject rather than sit on this one */
  if(!reduce&&!s.noalt&&SHOTW>SHOT_LEN){ SHOTW=0; ALTI++; SLATED=false; CUT=true; DODGEI=0; }
  const a=ALTS[ALTI%ALTS.length];
  const k=reduce?1:cl(SHOTW/MOVE_LEN);
  const fr=s.f(k,shipG.position,tan);
  let fv=((typeof s.fov==='function')?s.fov(k):s.fov)+(ALTI?a.fov:0);
  if(!reduce){
    const w=SHOTW;
    /* the drift. Never nailed down, never fast: a slow swing around the
       target, a slow lift, a slow push in over a long wait, and a breath of
       focal length under all of it. */
    const yaw=(ALTI?a.yaw:0)+Math.sin(w*.115+i)*.085+w*.0085*(i%2?1:-1);
    const lift=(ALTI?a.lift:1)*(1+Math.sin(w*.163+i*1.7)*.055);
    const dist=(ALTI?a.dist:1)*(1+Math.sin(w*.104+i*.9)*.05-Math.min(.14,w*.0021));
    const dx=fr.p.x-fr.t.x, dz=fr.p.z-fr.t.z;
    const r=Math.hypot(dx,dz)*dist, ang=Math.atan2(dz,dx)+yaw;
    fr.p.set(fr.t.x+Math.cos(ang)*r, fr.t.y+(fr.p.y-fr.t.y)*lift, fr.t.z+Math.sin(ang)*r);
    fv+=Math.sin(w*.19+i)*1.0;
  }
  safeCam(fr.p,fr.t);
  /* THE LENS FOLLOWS ITS MARK; IT IS NOT PLACED ON IT. Everything above picks
     a spot that can see, and it picks in STEPS: a dodge flips, the soft shell
     starts pushing, the ground clamp bites as the shot crosses the dock lip.
     Applied raw, every one of those is a jump — and a camera that jumps when
     it nears a wall is a camera the eye reads as HITTING the wall, which is
     the whole complaint. Filtered, they are a lean and a drift. A cut is the
     one place a jump belongs, so a cut is the one place this snaps. */
  if(CUT||SNAP||reduce){ CAMP.copy(fr.p); CAMLA.copy(fr.t); CUT=false; }
  else{
    CAMP.lerp(fr.p,1-Math.exp(-DTW/LAG_P));
    CAMLA.lerp(fr.t,1-Math.exp(-DTW/LAG_T));
  }
  fv=framed(fv);
  if(Math.abs(camera.fov-fv)>1e-4){camera.fov=fv;camera.updateProjectionMatrix();}
  const shake=(reduce?0:(s.follow?1.4:0.5))+(s.shake?bang*9:0)+bang*1.5;
  camera.position.copy(CAMP).add(V3(Math.sin(TT*1.7+i)*shake,Math.cos(TT*2.3+i)*shake,Math.sin(TT*1.1)*shake));
  camera.lookAt(CAMLA);
  if(!SLATED){
    SLATED=true;
    const sl=$("slate");
    if(sl){ sl.textContent=String(i+1).padStart(2,"0")+(ALTI?String.fromCharCode(64+ALTI):"")+" · "+s.n;
            sl.classList.remove("flash");void sl.offsetWidth;sl.classList.add("flash"); }
  }
  const fx=$("bang");
  if(fx) fx.style.opacity=(bang*bang*0.60).toFixed(3);
  const grade=$("grade");
  if(grade){
    grade.style.opacity=(0.12+0.34*GOLD).toFixed(3);
    grade.style.background=failing
      ? "radial-gradient(120% 100% at 50% 45%,rgba(210,60,30,"+(0.30+0.35*bang).toFixed(2)+") 0%,rgba(90,16,8,.55) 100%)"
      : "linear-gradient(180deg,rgba(40,60,120,.50),rgba(255,150,90,.12) 58%,rgba(255,196,120,.42))";
  }
  const ec=$("endcard");
  if(ec){
    const k2=eo(pr("live",.46,.74));
    ec.style.opacity=k2.toFixed(3);
    ec.style.transform="translate(-50%,"+(14*(1-k2)).toFixed(1)+"px)";
    $("ecUrl").textContent=SC.url;
    $("ecMeta").textContent=SC.meta||("live · deployed in "+Math.round(TOTAL)+"s");
  }
  renderer.render(scene,camera);
}

/* ---------- HUD ---------- */
const railEl=$("rail"),trackEl=$("track");
let groups=[],segEls=[];
function chrome(){
  groups=[];
  for(const b of SC.beats){
    const last=groups[groups.length-1];
    if(last&&last.rail===b.rail)last.ids.push(b.id); else groups.push({rail:b.rail,ids:[b.id]});
  }
  railEl.textContent="";
  groups.forEach(g=>{const d=document.createElement("div");d.className="pip";
    d.innerHTML='<span class="d"></span>'+g.rail;railEl.appendChild(d);g.el=d;});
  trackEl.textContent="";segEls=[];
  SC.beats.forEach(b=>{const d=document.createElement("div");d.className="seg";
    d.style.flexGrow=String(b.dur);d.style.flexBasis="0";d.title=b.rail+" · "+b.dur.toFixed(1)+"s";
    const i=document.createElement("i");d.appendChild(i);trackEl.appendChild(d);segEls.push({d,i,b});});
  $("tagLane").textContent=SC.lane;
  $("tTotal").textContent="/ "+Math.round(TOTAL)+"s";
  $("urlOut").textContent=SC.url;
  $("shotCount").textContent=SHOTS.length;
}
function hud(t){
  const failing=AT.repair?(t>=FAIL_T&&t<S("rebuild")):false;
  const beat=SC.beats.find(b=>t>=AT[b.id].s&&t<AT[b.id].e)||SC.beats[SC.beats.length-1];
  let st=beat.rail;
  if(failing)st="build failed · repair agent";
  if(t>=E("live")-0.3)st="live";
  const facts=[st];
  /* A release number and a node name the deploy never told us are inventions,
     and an invention next to a real stage name is the one thing this film must
     not do. Blank means the caller has none, so neither do we. */
  if(SC.release&&t>=S("release")+AT.release.d*.4)facts.push("release "+SC.release);
  if(SC.node&&t>=S("place"))facts.push("node "+SC.node);
  $("status").textContent=facts.join("   ·   ");
  $("urlOut").classList.toggle("on",pr("live",.2,.6,t)>.5);
  groups.forEach(g=>{
    const s=AT[g.ids[0]].s,e=AT[g.ids[g.ids.length-1]].e;
    const bad=failing&&(g.rail==="build"||g.rail==="repair-agent");
    g.el.className="pip"+(bad?" bad":t>=e?" done":t>=s?" now":"");
  });
  segEls.forEach(({d,i,b})=>{
    const w=AT[b.id];i.style.transform="scaleX("+seg(t,w.s,w.e).toFixed(3)+")";
    d.classList.toggle("bad",(b.id==="build"&&AT.repair)||b.id==="repair");
  });
  $("head").style.left=(100*cl(t/TOTAL))+"%";
  $("tElapsed").textContent=Math.round(t)+"s";
  /* LIVE overrides the scripted log entirely: if the deploy is talking, the
     film has no business narrating over it with lines from a fictional one. */
  const show=LIVE?LIVE.slice(-6):LOGS.filter(l=>l.t<=t).slice(-6);
  const sig=show.length?show[0].t+"|"+show[show.length-1].t+"|"+show.length+"|"+show[show.length-1].m:"";
  const boxEl=$("log");
  if(sig!==boxEl.dataset.sig){
    boxEl.dataset.sig=sig;
    boxEl.innerHTML=show.map(l=>{
      const glyph=l.k==="g"?"✓":l.k==="e"?"✕":l.k==="a"?"◆":"·";
      return '<div class="'+(l.k||"")+'"><span class="t">'+String(Math.floor(l.t)).padStart(3," ")+
        's</span><span class="k">'+glyph+'</span><span class="m">'+esc(l.m)+'</span></div>';
    }).join("");
  }
}

/* ---------- player ---------- */
let t=0,playing=true,speed=1,last=null,ready=false,dirty=true,raf=0,ENDED=false;
let mode="stages",stage=0;

/* ---------- how fast the story runs ----------
   The first cut of this played a stage at ten times life and then stopped dead
   at the end of it, and the deploy would sit in that stage for another three
   minutes. So two thirds of every deploy was a frozen frame, and the third
   that moved went past too fast to read. Both halves of that are the same
   mistake: treating the scripted duration of a beat as the speed to play it.
   What it does instead, inside a stage —

     * it takes at least MINWALL seconds over the move, however short the beat
       is written. A beat scripted at 0.6s is not worth six frames.
     * it never runs faster than NOM, however long the beat is written.
     * and it EASES OFF towards the end, down to a crawl, and stops just short
       of it. The last sliver of every stage belongs to the deploy: the film
       gets arbitrarily close to finished and only finishes when the real thing
       does.

   That last rule is what keeps it honest. It is an asymptote, which is the one
   shape of progress that cannot lie — and it costs nothing in liveliness,
   because everything the eye actually reads as motion (the yard, the water,
   the traffic, the ferries, the camera) runs on the wall clock and does not
   slow down with it.

   Behind the deploy it catches up: whatever the backlog, it is cleared inside
   MAXLAG seconds, so a fast deploy gets a fast film rather than a film running
   four stages late. */
const NOM=2.4;       // story-seconds per wall-second, at the very fastest
const T0=6;          // the creep's half-life-ish, in wall seconds
const ALPHA=.85;     // ...and how heavy its tail is
const LASTWALL=24;   // the closing stage is not paced, it is played, over this
const NEVER=.008;    // and every other stage stops this short of its end
const MAXLAG=7;      // seconds to clear a backlog when the deploy is ahead of us

/* ---------- the stages that are worth more than their story time ----------
   Everything in this film is paced by the deploy, and the deploy has no
   opinion about which of its stages is worth watching. One of them is: the
   dock flooding and the gates swinging back, which is the only piece of
   machinery in the picture and used to go past in a second and a half
   whenever the deploy was ahead of us. So it gets its own rate — a multiplier
   on the film's, applied wherever a rate is (the catch-up sprint included,
   because being late is exactly when the sprint eats it).

   The run out into the sun is the other one. In stage mode — which is what a
   real deploy drives — it is not paced at all, it is played, over LASTWALL;
   the rate here is only what the free-running cut plays it at. */
const PACE={release:.42,done:.45};
const paceOf=i=>PACE[(STAGES[i]||{}).rail]||1;

/**
 * How far into a stage the film should be, given only how long it has been in
 * it — which is the one honest input available. The deploy has not said how
 * long this will take, and nothing in this file is allowed to guess.
 *
 * A POWER LAW, not the usual exponential. An exponential is spent inside
 * twenty seconds: it would put the hull fully plated half a minute into a
 * four-minute build and then leave it there, which is the failure this whole
 * change is about, in a subtler costume. This one is still visibly moving at
 * four minutes — 0.87 at a minute, 0.93 at two, 0.96 at four — so the plating
 * is always creeping forward by an amount the eye can find.
 */
const creep=w=>1-Math.pow(1+Math.max(0,w)/T0,-ALPHA);
/** Wall seconds spent in the stage the film is currently on. */
let SW=0;
/**
 * The film's own canvas, made here rather than taken from the page.
 *
 * A canvas has ONE WebGL context for its lifetime: once a context is lost —
 * and `destroy` loses it deliberately, to give the GPU back — that element can
 * never have another. React keeps the DOM across a strict-mode remount, so a
 * borrowed canvas comes back white and stays white, which is a blank film on
 * every deploy in development and on any surface that mounts this twice.
 *
 * A canvas per mount, thrown away with the mount, has no such history.
 */
const holder=$("cv");
const cv=document.createElement("canvas");
holder.appendChild(cv);
function stageUI(){
  const el=$("stagebar"); if(!el) return;
  const st=STAGES[stage]||{name:"",note:""};
  el.hidden=(mode!=="stages");
  el.classList.toggle("held",HOLDING);
  $("stageNo").textContent=(stage+1)+" / "+STAGES.length;
  $("stageName").textContent=st.name;
  $("stageNote").textContent=HOLDING?st.note:"running…";
  $("next").textContent=stage>=STAGES.length-1?"Replay":"Next stage →";
  $("prev").disabled=stage<=0;
  const pl=$("play"); if(pl) pl.textContent=ENDED?"Replay":playing?"Pause":"Play";
}
/**
 * Play up to stage `i` and wait there.
 *
 * Forward is not a jump. The film RUNS there — fast, but visibly, and the
 * backlog is cleared inside MAXLAG seconds however big it is — because a cut
 * that teleports past three beats is a cut nobody sees, and the whole
 * complaint about the first version of this was that the only parts that
 * moved went by too fast to notice.
 *
 * Backwards does jump. Nothing but a scrubber, a Prev button and a scenario
 * reload ever asks for it, and a deploy cannot go backwards at all.
 */
function goStage(i,seek){
  const to=cl(i,0,STAGES.length-1);
  if(seek===true||to<stage||t>STAGES[to].e){ t=STAGES[to].s; SNAP=true; SHOTW=0; ALTI=0; }
  SW=t>=STAGES[to].s?0:SW;
  stage=to; HOLDING=false; ENDED=false; playing=true;
  dirty=true; stageUI(); kick();
}
function nextStage(){
  if(mode!=="stages"){ playing=true; kick(); return; }
  if(stage>=STAGES.length-1){ goStage(0,true); return; }
  goStage(stage+1);
}
/* The shape of the frame.
   Every shot below is composed at 2.40:1 — that is what the fovs in `shots()`
   were chosen against, and on the dashboard and the bench it is exactly what
   the canvas gets. The ROOM gives the film the whole viewport instead, which
   is whatever shape the window is, so the frame can no longer be assumed. */
const FRAME=960/400;
let ASPECT=FRAME;
/* The composed fov, corrected for a frame that is not 2.40:1.
   A PerspectiveCamera's fov is VERTICAL, so handing a 16:9 window the fov a
   2.40:1 shot was framed with does not letterbox it — it crops the sides, and
   the sides are where the bridge, the yard and the city are. This holds the
   HORIZONTAL field the shot was composed with and lets the extra height show
   more sky and water, which the scene has and which costs the composition
   nothing. Identity at 2.40:1, so no surface that had this framing changes. */
function framed(f){
  if(Math.abs(ASPECT-FRAME)<1e-3) return f;
  const half=Math.atan(Math.tan(f*Math.PI/360)*(FRAME/ASPECT))*360/Math.PI;
  /* A very tall window would otherwise ask for a fisheye. Past this the frame
     stops widening and the picture is allowed to crop, which looks like a
     close shot rather than like a lens fault. */
  return Math.min(110,half);
}
function resize(){
  const w=cv.clientWidth||960;
  /* The canvas's own box is the truth when it has one. On a surface that sizes
     it by `aspect-ratio: 960/400` this is the same number the old line
     computed; on a full-viewport one it is the window. */
  const h=Math.round(cv.clientHeight)||Math.round(w*400/960);
  ASPECT=w/h;
  renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
  renderer.setSize(w,h,false);
  camera.aspect=w/h; camera.updateProjectionMatrix(); dirty=true; if(ready)kick();
}
/* A paused film is a still. When nothing is moving the loop stops entirely
   rather than idling — cheaper, and a page with no pending frame is one a
   headless browser will actually call finished. */
function frame(ts){
  raf=0;
  if(last===null)last=ts;
  const dt=Math.min(.08,(ts-last)/1000);last=ts;
  if(reduce){ if(dirty){step(t);hud(t);dirty=false;} return; }
  if(playing){
    /* the wall clock, which is what the picture is alive on */
    WALL+=dt; DTW=dt; SHOTW+=dt;
    if(!ENDED){
      if(mode==="stages"){
        const st=STAGES[stage]||{s:0,e:TOTAL};
        const span=Math.max(.001,st.e-st.s);
        const last=stage>=STAGES.length-1;
        if(t<st.s-1e-6){
          /* behind the deploy. Run there — fast, but run, because a cut that
             teleports past three beats is a cut nobody sees. However big the
             backlog, it is gone inside MAXLAG seconds. */
          t=Math.min(st.s,t+dt*Math.max(NOM*2.2,(st.s-t)/MAXLAG)*paceOf(stageAt(t))*speed);
          if(t>=st.s-1e-6) SW=0;
        }else{
          SW+=dt*speed;
          /* the creep, capped so that it never opens faster than NOM however
             short the beat is written — and slowed to this stage's own rate */
          const pc=paceOf(stage);
          const p=last?Math.min(1,SW/LASTWALL)
                      :Math.min(creep(SW*pc),SW*NOM*pc/span,1)*(1-NEVER);
          t=Math.max(t,Math.min(st.s+span*p,st.e));
        }
        /* "Held" is a thing we say, not a thing that happens: the creep never
           actually arrives (by design — the last of a stage is the deploy's).
           After this long in one stage the deploy is plainly slow, and the
           stage bar is allowed to say what it is waiting for. */
        const held=!last&&SW>22;
        if(held!==HOLDING){ HOLDING=held; stageUI(); }
        if(stage>=STAGES.length-1&&t>=TOTAL-1e-3){
          t=TOTAL; ENDED=true; HOLDING=true;
          const pl=$("play"); if(pl) pl.textContent="Replay";
          stageUI();
        }
      }else{
        t+=dt*NOM*paceOf(stageAt(t))*speed;
        if(t>=TOTAL){ t=TOTAL; ENDED=true; const pl=$("play"); if(pl) pl.textContent="Replay"; stageUI(); }
      }
    }
    dirty=true;
  }
  /* Note that the loop keeps going after the story stops. It has to: the water
     is still moving, the ferries are still crossing, and the camera is still
     drifting, which is the difference between a last frame and a still. */
  if(dirty){step(t);hud(t);dirty=false;SNAP=false;}
  if(playing||dirty) raf=requestAnimationFrame(frame);
}
function kick(){ last=null; if(!raf) raf=requestAnimationFrame(frame); }
function load(key){
  compile(key);buildStages();SHOTS=shots();chrome();$("log").dataset.sig="";LASTCUT=-1;
  stage=0;HOLDING=false;SHOTW=0;ALTI=0;SNAP=true;ENDED=false;SW=0;
  if(reduce){t=TOTAL;playing=false;ENDED=true;$("play").textContent="Replay";}
  else{t=0;playing=true;$("play").textContent="Pause";}
  stage=stageAt(t);
  step(t);hud(t);stageUI();
}
function boot(){
  try{ renderer=new THREE.WebGLRenderer({canvas:cv,antialias:true,preserveDrawingBuffer:opts.preserveDrawingBuffer===true}); }
  catch(e){ $("fallback").hidden=false; cv.hidden=true; return; }
  if(!renderer.getContext()){ $("fallback").hidden=false; cv.hidden=true; return; }
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.NoToneMapping;      // flat colour, no filmic curve
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled=true;
  camera=new THREE.PerspectiveCamera(32,960/400,1,32000);
  const s0=opts.scenario;
  try{
    compile(SCENARIOS[s0]?s0:"container");
    palette(0);
    buildScene();
    ro=new ResizeObserver(resize); ro.observe(cv); resize();
    $("scenario").value=SCENARIOS[s0]?s0:"container";
    load($("scenario").value);
  }catch(err){
    $("fallback").hidden=false; $("fallback").textContent=String(err&&err.stack||err);
    $("fallback").style.whiteSpace="pre-wrap"; $("fallback").style.textAlign="left";
    cv.hidden=true; return;
  }
  ready=true;
  /* the outside handle: a real deploy drives this */
  handle={
    seek(f){ t=cl(f,0,1)*TOTAL; playing=false; HOLDING=false; ENDED=false; stage=stageAt(t);
             SNAP=true; SHOTW=0; ALTI=0; SW=0;
             $("play").textContent="Play"; dirty=true; step(t); hud(t); stageUI(); },
    seconds(){ return TOTAL; },
    scenario(k){ if(SCENARIOS[k]){ $("scenario").value=k; rebuild(k); } },
    shots(){ return SHOTS.map(s=>s.n); },
    /* what a real deploy talks to: the rails it already reports */
    stages(){ return STAGES.map(s=>s.rail); },
    stage(){ return {i:stage,rail:STAGES[stage].rail,holding:HOLDING}; },
    next(){ nextStage(); },
    /* setStage("fleet") — run the film forward to that stage and hold there */
    setStage(x){
      const i=typeof x==="number"?x:STAGES.findIndex(s=>s.rail===x);
      if(i<0) return false;
      mode="stages"; $("mode").value="stages"; goStage(i); return true;
    },
    /* Stop where we are, at the near edge of the end of this stage. Used by
       nothing in the product — the pacing arrives there by itself — and kept
       because a surface that wants to freeze the film on a beat should not
       have to know how. */
    hold(){ const st=STAGES[stage]; if(!st) return;
            t=st.e-Math.max(.001,st.e-st.s)*NEVER; HOLDING=true; SW=99; dirty=true; stageUI(); kick(); },
    mode(m){ if(m==="film"||m==="stages"){ $("mode").value=m; setMode(m); } },
    /* the app's own name, address, lane and endcard line, over the scenario's */
    identity(o){
      // Her NAME is painted into a texture when the hull is made, so a deploy
      // that tells us what it is deploying after the scene exists needs the
      // scene again. It arrives in the first second, on the beat where there is
      // no ship yet, so the rebuild is never seen.
      const renamed=o.app!==undefined&&o.app!==SC.app;
      IDENT={...IDENT,...o};
      SC={...SC,...IDENT};
      if(renamed){ const at=stage; rebuild(KEY); goStage(at); }
      chrome(); dirty=true; kick();
    },
    /* the deploy's own log, which replaces the scripted one wholesale */
    log(lines){ LIVE=lines; $("log").dataset.sig=""; dirty=true; kick(); },
    destroy,
  };

  kick();
}
function rebuild(key){
  crates=[];bays=[];ribs=[];clouds=[];birds=[];smoke=[];blackSmoke=[];splash=[];sparks=[];
  dockGates=[];yardLamps=[];
  fires=[];debris=[];fogs=[];boats=[];hullParts=[];
  compile(key); palette(0); buildScene(); load(key);
}
function setMode(m){
  mode=m;
  if(m==="stages"){ stage=stageAt(t); HOLDING=false; playing=true; }
  else { HOLDING=false; }
  dirty=true; stageUI(); kick();
}
/* ---------- the player's own controls ----------
   Drawn by the motion study and by nothing in the product: a deploy screen has
   no Pause button, because the thing being played is not ours to pause. Wired
   only when the caller asked for them AND drew them, so the same module serves
   both surfaces. */
if(controls){
  const on=(id,ev,fn)=>{ const e=el(id); if(e) e.addEventListener(ev,fn,sig); };
  on("play","click",()=>{
    if(t>=TOTAL&&mode==="film")t=0;
    playing=!playing;dirty=true;kick();stageUI();
    $("play").textContent=playing?"Pause":"Play";
  });
  on("restart","click",()=>{t=0;stage=0;HOLDING=false;playing=true;dirty=true;kick();stageUI();$("play").textContent="Pause";});
  on("scenario","change",e=>{if(ready){rebuild(e.target.value);kick();}});
  on("speed","change",e=>{speed=Number(e.target.value);});
  on("mode","change",e=>setMode(e.target.value));
  on("next","click",nextStage);
  on("prev","click",()=>goStage(stage-1));
  const scrub=el("scrub");
  if(scrub){
    const scrubTo=x=>{const r=scrub.getBoundingClientRect();t=cl((x-r.left)/r.width)*TOTAL;
      HOLDING=false;stage=stageAt(t);dirty=true;kick();stageUI();};
    let dragging=false;
    scrub.addEventListener("pointerdown",e=>{dragging=true;playing=false;$("play").textContent="Play";
      scrub.setPointerCapture(e.pointerId);scrubTo(e.clientX);},sig);
    scrub.addEventListener("pointermove",e=>{if(dragging)scrubTo(e.clientX);},sig);
    scrub.addEventListener("pointerup",()=>{dragging=false;},sig);
  }
  el("cv")?.addEventListener("click",()=>{ if(mode==="stages") nextStage(); },sig);
  addEventListener("keydown",e=>{
    if(/^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName||"")))return;
    if(e.key==="ArrowRight"||e.key==="Enter"){nextStage();e.preventDefault();}
    else if(e.key==="ArrowLeft"){goStage(stage-1);e.preventDefault();}
  },sig);
}

/**
 * Give back the GPU.
 *
 * A browser allows a page a small number of live WebGL contexts and silently
 * kills the oldest when it runs out. React's strict mode mounts an effect
 * twice, and a deploy screen that is opened, left and opened again would leak
 * one context per visit — so this is not tidiness, it is the difference between
 * the film working the fourth time somebody deploys and not.
 */
function destroy(){
  abort.abort();
  cv.remove();
  if(raf) cancelAnimationFrame(raf);
  raf=0; playing=false; ready=false;
  ro?.disconnect(); ro=null;
  scene?.traverse(o=>{
    o.geometry?.dispose?.();
    const m=o.material; if(!m) return;
    (Array.isArray(m)?m:[m]).forEach(x=>{ x.map?.dispose?.(); x.dispose?.(); });
  });
  renderer?.dispose();
  renderer?.forceContextLoss?.();
  renderer=null;
}

let handle=null;
let ro=null;
boot();
/* Boot failed — no WebGL, or the scene threw. The caller gets a handle that
   accepts every call and does nothing, rather than a null it has to guard on
   every line: a deploy must not stop because a picture of it would not draw. */
return handle||{
  seek(){},seconds(){return 0;},scenario(){},shots(){return [];},
  stages(){return [];},stage(){return {i:0,rail:"",holding:false};},
  next(){},setStage(){return false;},hold(){},mode(){},identity(){},log(){},
  destroy(){ abort.abort(); },
};
}
