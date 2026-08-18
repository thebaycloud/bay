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
 * This runs on the deploy. `setStage` plays to the end of a stage and HOLDS
 * there, camera still moving, until the next stage arrives — so the picture
 * waits exactly as long as the deploy waits, and the only thing a fast build
 * changes is how soon the cut comes. The rails the film knows are the stage
 * names lib/stage-names.ts declares, deliberately: see lib/deploy-film.ts for
 * the mapping, which is one table and no cleverness.
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
    night:{zen:0x1B2A4A,hor:0x40567A,sun:0x93A8C6,water:0x1B3450,water2:0x0F2138,foam:0x6E88A6,ggo:0xA8412A,land:0x33405A,land2:0x222C40,city:0x2E3C56,amb:0.85,key:0.7},
    blue: {zen:0x2E4F7E,hor:0xAE8894,sun:0xFFD9A8,water:0x2A4E6E,water2:0x16304A,foam:0xA8BCCC,ggo:0xC24A2C,land:0x5A5A66,land2:0x38384A,city:0x53607A,amb:1.2,key:1.4},
    dawn: {zen:0x6FB2E2,hor:0xFFD2A0,sun:0xFFF4CC,water:0x3E8FB0,water2:0x235E80,foam:0xFFF2E4,ggo:0xF2542D,land:0xC0AE6A,land2:0x87885C,city:0xB0BCCC,amb:1.7,key:2.2}
  },
  dark:{
    night:{zen:0x070C16,hor:0x18222E,sun:0x4E6182,water:0x081320,water2:0x040A12,foam:0x27384A,ggo:0x7A2C1C,land:0x121924,land2:0x0A1018,city:0x121A28,amb:0.5,key:0.45},
    blue: {zen:0x0E2038,hor:0x543E52,sun:0xBE8664,water:0x102C42,water2:0x08172A,foam:0x566C82,ggo:0xA33C24,land:0x242E3A,land2:0x141C24,city:0x263048,amb:0.8,key:1.0},
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
let PN={amb:1,key:2}, GOLD=0, NIGHT=1, SUNEL=-.08;
/* The grade is pinned to light.
   This read the page's own data-theme and graded itself to match, which is why
   the frame around it could stay plain. The product is light-only now, so there
   is no attribute to read and matchMedia would have put the picture in night
   colours on a light page for anyone whose OS prefers dark. PALS.night is not
   dead — it is the film's own dusk, driven by GOLD below, not by a theme. */
function palette(t){
  const P=PALS.light;
  const blue=eio(seg(t,S("upload"),E("flood")));
  GOLD=eio(seg(t,S("place")+AT.place.d*.30,E("live")-2.5));
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

let renderer,scene,camera,keyLight,rimLight,weldLight,water,waterMat,skyMat,sunDisc,sunRing;
let shipG,hullParts=[],house,funnel,funnelMark=[],band,radar,radarBar,mast,flag,flagPole,
    bays=[],ribs=[],keel,deckPlate,bulwark,nameDecals=[],relDecals=[],lifeboat,
    gantry,trolley,hoist,hook,dockG,dockWater,dockGates=[],yardLamps=[],beacon,beaconLamp,
    crates=[],sparks=[],weldArc,drone,droneEye,fires=[],fireGlow,smoke=[],blackSmoke=[],debris=[],splash=[],
    clouds=[],birds=[],fogs=[],boats=[],tug,buoy,buoyLamp,landMesh,cars=[],carLamps=[],
    cityG,alcatraz,plateClip,OUTLINE,OUTLINE_CLIP,RAMP;

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
function terrain(cx,cz,w,d,sw,sd,hf,mat){
  const g=new THREE.PlaneGeometry(w,d,sw,sd);
  g.rotateX(-Math.PI/2); g.translate(cx,0,cz);
  const p=g.attributes.position;
  for(let i=0;i<p.count;i++) p.setY(i,hf(p.getX(i),p.getZ(i)));
  const m=new THREE.Mesh(bandGeo(g,LAND_BANDS),mat);
  m.receiveShadow=true; scene.add(m); return m;
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
  const road=Math.exp(-Math.pow(z/210,2));            // the road cuts a saddle
  h=lerp(h,Math.min(h,BR.deck+26),road*.92);
  const q=Math.exp(-(Math.pow((x-DOCK.x)/610,2)+Math.pow((z-DOCK.z)/450,2)));
  h=lerp(h,-34,cl(q*1.15));                            // the yard, cut into the hill
  return h;
}
/* the city side: a lower bluff, then the land runs away east */
function hS(x,z){
  const t=cl((x-1050)/700);
  let h=-46+330*Math.pow(t,.8);
  h+=54*Math.sin(x*.0027-.6)*Math.cos(z*.0031+1.1);
  h+=30*Math.sin(z*.0049+2.2);
  const road=Math.exp(-Math.pow(z/240,2));
  h=lerp(h,Math.min(h,BR.deck-8),road*.9);
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
  const B=new THREE.Group(); scene.add(B);

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
  const wm=new THREE.MeshBasicMaterial({color:0xFFDCA0,fog:false,transparent:true,opacity:0});
  scene.userData.winMat=wm;
  const CX=2050, CZ=2150;                       // downtown, and how far out it reaches
  rs(31);
  /* the towers. Height falls off with distance from the core, with noise, so
     the silhouette has a peak and shoulders instead of a flat hedge. */
  for(let i=0;i<86;i++){
    const a=rnd()*6.283, r=Math.pow(rnd(),.62)*1500;
    const x=CX+Math.cos(a)*r*1.15, z=CZ+Math.sin(a)*r*.8;
    if(z<1420) continue;                        // nothing in the water
    const core=Math.exp(-Math.pow(r/720,1.7));
    const h=54+core*330*(.55+rnd()*.75)+rnd()*46;
    const w=34+rnd()*30+core*22, d=w*(.75+rnd()*.5);
    box(w,h,d,rnd()<.3?m2:m,x,h/2-6,z,cityG,2.6);
    if(h>150&&rnd()<.55) box(w*.66,h*.22,d*.66,m,x,h+h*.11-6,z,cityG,2.4);   // a setback
    if(h>230&&rnd()<.5)  cyl(1.6,2.4,40,5,m,x,h+h*.22+14,z,cityG,1.4);       // a mast
    /* lit windows: two banked planes per tower, facing the gate */
    if(rnd()<.8){
      const rows=Math.max(2,Math.round(h/58));
      for(let r2=0;r2<rows;r2++){
        const pw=new THREE.Mesh(new THREE.PlaneGeometry(w*.72,7),wm);
        pw.position.set(x,26+r2*(h-40)/rows,z-d/2-1.2);cityG.add(pw);
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
}

/* ---------- the water ---------- */
function buildWater(){
  waterMat=new THREE.ShaderMaterial({
    uniforms:{c1:{value:PC.water.clone()},c2:{value:PC.water2.clone()},foam:{value:PC.foam.clone()},
              sun:{value:PC.sun.clone()},time:{value:0},dusk:{value:0},fogColor:{value:new THREE.Color()},
              fogNear:{value:1400},fogFar:{value:8200},
              shipPos:{value:V3(0,0,0)},shipDir:{value:new THREE.Vector2(0,-1)},wake:{value:0},
              /* the dry dock is a hole in the sea until the gates open */
              dockC:{value:new THREE.Vector2(DOCK.x,DOCK.z)},
              dockU:{value:new THREE.Vector2(HU.x,HU.z)},
              dockB:{value:V3(DK.x0-30,DK.x1,DK.hw+8)},dockCut:{value:1}},
    vertexShader:`varying vec3 wp; varying float vDepth;
      void main(){ vec4 w=modelMatrix*vec4(position,1.); wp=w.xyz;
        vec4 mv=viewMatrix*w; vDepth=-mv.z; gl_Position=projectionMatrix*mv; }`,
    fragmentShader:`
      uniform vec3 c1,c2,foam,sun,fogColor,shipPos,dockB; uniform vec2 shipDir,dockC,dockU;
      uniform float time,dusk,fogNear,fogFar,wake,dockCut;
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
function buildShip(){
  shipG=new THREE.Group(); scene.add(shipG);
  plateClip.normal.set(-1,0,0); plateClip.constant=0;
  const topsides=toon(0x2E3C48,1), boot=toon(0xA8342A,1), deckM=toon(0x54606B,1),
        white=toon(0xF2EEE2,1), dark=toon(0x2A3038,1);
  hullParts=[];
  const up=new THREE.Mesh(hullGeo(false),topsides); up.castShadow=true; shipG.add(up); hullParts.push(up);
  const lo=new THREE.Mesh(hullGeo(true),boot); lo.castShadow=true; shipG.add(lo); hullParts.push(lo);
  const oh=new THREE.Mesh(up.geometry,OUTLINE_CLIP);
  oh.scale.set(1.022,1.07,1.07); oh.position.y=-1.2; oh.renderOrder=-1; up.add(oh);
  const ol2=new THREE.Mesh(lo.geometry,OUTLINE_CLIP);
  ol2.scale.set(1.018,1.10,1.06); ol2.position.y=.6; ol2.renderOrder=-1; lo.add(ol2);
  /* the boot-top line, and the hatch deck */
  hullParts.push(box(236,3,58,toon(0xE8E2D2,1),-2,4,0,shipG,false,1));
  deckPlate=box(232,5,56,deckM,-4,31,0,shipG,false,1); hullParts.push(deckPlate);
  for(let i=0;i<6;i++) hullParts.push(box(4,3,56,dark,-52+i*24,34,0,shipG,false,1));
  /* forecastle + bulwark + the anchor */
  bulwark=box(46,13,52,topsides,96,38,0,shipG,2,1); hullParts.push(bulwark);
  hullParts.push(box(38,7,44,deckM,94,43,0,shipG,false,1));
  hullParts.push(box(9,13,3,toon(0x1E242B,1),108,26,29,shipG,false,1));
  hullParts.push(box(9,13,3,toon(0x1E242B,1),108,26,-29,shipG,false,1));
  /* keel + ribs, for the build */
  keel=box(238,8,22,toon(0x1E2630),-2,-15,0,shipG,false);
  const ribMat=toon(0x44515D);
  ribs=[];
  for(let i=0;i<10;i++){const e=box(6,52,56,ribMat,-104+i*23,12,0,shipG,false);e.visible=false;ribs.push(e);}
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
  for(let i=0;i<10;i++){
    const e=new THREE.Mesh(new THREE.SphereGeometry(9,7,6),
      new THREE.MeshBasicMaterial({color:0xF2F0EA,transparent:true,opacity:.5,depthWrite:false}));
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
  /* work lights on the quay — the yard runs at night */
  yardLamps=[];
  [[-336,214],[210,214],[-60,214],[-330,-246],[-60,-246],[210,-246]].forEach(([x,z])=>{
    cyl(3,4,74,6,steel,x,DK.quay+37,z,dockG,false);
    const l=new THREE.Mesh(new THREE.SphereGeometry(7,8,7),
      new THREE.MeshBasicMaterial({color:0xFFE2A6,fog:false,transparent:true,opacity:0}));
    l.position.set(x,DK.quay+76,z); dockG.add(l); yardLamps.push(l);
  });

  gantry=new THREE.Group(); dockG.add(gantry);
  [-182,182].forEach(dz=>{
    box(15,152,15,steel,DK.x0+16,DK.quay+76,dz,gantry);
    box(15,152,15,steel,DK.x1-20,DK.quay+76,dz,gantry);
  });
  box(W+40,15,17,steel,CX,DK.quay+158,-182,gantry); box(W+40,15,17,steel,CX,DK.quay+158,182,gantry);
  trolley=box(54,24,386,steel,0,DK.quay+140,0,gantry);
  hoist=box(6,86,6,steel,0,DK.quay+90,0,gantry,false);
  hook=box(30,14,30,steel,0,DK.quay+44,0,gantry);
  const bl=new THREE.Mesh(new THREE.SphereGeometry(7,9,7),new THREE.MeshBasicMaterial({color:0xE8402A,fog:false,transparent:true,opacity:0}));
  bl.position.set(DK.x0+16,DK.quay+168,0);gantry.add(bl);gantry.userData.alarm=bl;
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
}

function buildScene(){
  scene=new THREE.Scene();
  scene.fog=new THREE.Fog(0xffffff,1400,8200);
  RAMP=RAMP||ramp();
  plateClip=new THREE.Plane(V3(-1,0,0),0);
  OUTLINE=new THREE.MeshBasicMaterial({color:0x211d1a,side:THREE.BackSide,fog:false});
  OUTLINE_CLIP=new THREE.MeshBasicMaterial({color:0x211d1a,side:THREE.BackSide,fog:false,clippingPlanes:[plateClip]});
  cars=[];carLamps=[];nameDecals=[];relDecals=[];funnelMark=[];

  /* sky — hard bands, the way a background painter would do it */
  skyMat=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,
    uniforms:{zen:{value:PC.zen},hor:{value:PC.hor},sun:{value:PC.sun},
              sunDir:{value:V3(0,.1,1).normalize()},dusk:{value:0},stars:{value:1}},
    vertexShader:`varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`
      uniform vec3 zen,hor,sun,sunDir; uniform float dusk,stars; varying vec3 vD;
      void main(){
        float h=clamp(vD.y*2.6+0.06,0.,1.);
        float b=floor(pow(h,0.7)*6.0)/6.0;              // six flat bands
        vec3 c=mix(hor,zen,b);
        // stars, banded onto a grid so they hold still and stay cartoon
        float sh=fract(sin(dot(floor(vD*116.0),vec3(12.9898,78.233,37.719)))*43758.5453);
        c+=vec3(0.85,0.88,1.0)*step(0.9974,sh)*stars*smoothstep(0.0,0.34,vD.y);
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
  scene.add(new THREE.AmbientLight(0xffffff,1.6));
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
  terrain(-2150,180,2900,3000,46,46,hN,landMat);
  terrain(2250,220,2900,3000,44,44,hS,landMat);
  terrain(1180,1460,480,380,20,16,hAlc,landMat);
  buildBridge();
  buildCity();
  buildYard();
  buildShip();
  buildDrone();
  buildBay();
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
    {t:S_("plan"),n:"TRUCK · THE AGENT READS",fov:36,
     f:k=>({p:D(-244+130*eio(k),36,-134),t:D(90,-32,0)})},
    /* down on the floor of the dock, inside it, as the keel is laid */
    {t:S_("render"),n:"LOW · THE KEEL",fov:46,
     f:k=>({p:D(216-18*k,-2,42),t:D(-150,-28,0)})},
    {t:S_("build",.26),n:"TRACK · PLATING",fov:36,
     f:k=>({p:D(-290+430*k,48,-138),t:D(-140+340*k,-8,0)})},
    {t:S_("build",.80),n:"3/4 · SUPERSTRUCTURE",fov:34,
     f:k=>({p:D(-334+36*eio(k),94,-232),t:D(-88,16,0)})},
    /* the failure, and the three shots it earns */
    {t:FAIL_T-0.35,req:"repair",n:"SNAP · THE BREAK",fov:k=>lerp(46,28,eio(cl(k*3))),shake:1,
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
     f:k=>({p:D(-290+430*k,48,-138),t:D(-140+340*k,-8,0)})},
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
    {t:S_("live",.24),n:"PULL BACK · SUNRISE",fov:k=>lerp(30,46,eio(k)),
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

/* ---------- frame ---------- */
let TT=0,LASTCUT=-1,HOLDT=0,HOLDING=false;
const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
const _v=V3(0,0,0);
function step(t){
  /* story time is t; TT is wall time, which keeps running while a stage holds
     so that a held frame is a live picture and not a paused one */
  NOW=t; TT=reduce?0:t+HOLDT;
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
  wu.time.value=TT; wu.dusk.value=GOLD;
  keyLight.color.copy(PC.sun).lerp(new THREE.Color(0xffffff),.35);
  keyLight.intensity=PN.key*(failing?.55:1);
  rimLight.color.copy(PC.zen).lerp(new THREE.Color(0xffffff),.5);
  scene.userData.orange.color.copy(PC.ggo);
  scene.userData.dark.color.copy(PC.ggo).multiplyScalar(.62);
  scene.userData.terrainMat.color.copy(PC.land);

  scene.userData.cityMat.color.copy(PC.city);
  scene.userData.cityMat2.color.copy(PC.city).multiplyScalar(.82);
  scene.userData.funnelMesh.material.color.copy(PC.ggo);
  splash.forEach(e=>e.material.color.copy(PC.foam));
  scene.userData.cloudMat.color.copy(PC.hor).lerp(new THREE.Color(0xffffff),.55);
  scene.userData.fogMat.opacity=.16+.34*GOLD;
  scene.userData.winMat.opacity=NIGHT*.9;
  carLamps.forEach(l=>l.material.opacity=NIGHT*.85);
  yardLamps.forEach(l=>l.material.opacity=NIGHT*.9);
  nameDecals.forEach(d=>d.material.color.setScalar(lerp(.62,1,1-NIGHT)));

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
  keel.position.x=-2-124*(1-keel.scale.x);
  const ribP=seg(bp,.02,.40);
  ribs.forEach((e,i)=>{const k=eo(seg(ribP,i/10,(i+1)/10));e.visible=k>.05;e.scale.y=Math.max(.05,k);e.position.y=-15+27*k;});
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
  trolley.position.x=gx; hoist.position.x=gx; hook.position.x=gx;
  const down=(t>E("clone")&&t<E("upload"));
  hoist.scale.y=down?1:.3; hoist.position.y=DK.quay+(down?90:130);
  hook.position.y=DK.quay+(down?44+Math.sin(TT*1.6)*2:118);
  gantry.userData.alarm.material.opacity=failing?(Math.sin(TT*7)>0?1:.1):0;

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
    const k=(TT*.35+i*.1)%1, sway=Math.sin(k*5.2+i)*26*k;
    const o=shipG.localToWorld(V3(-104,102,0));
    e.position.set(o.x-tan.x*k*170+tan.z*sway,o.y+k*118+Math.sin(k*9+i)*6,
                   o.z-tan.z*k*170-tan.x*sway);
    e.scale.setScalar((.45+k*2.9)*(.75+.5*((i*7)%5)/5));
    e.material.opacity=.40*(1-k)*(1-.25*((i*3)%4)/4);
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
  keyLight.position.copy(shipG.position).add(sunDir.clone().multiplyScalar(900)).setY(680);

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

  /* the camera: whichever shot we are in */
  const {s,i,k}=shotAt(t);
  const fr=s.f(k,shipG.position,tan);
  let fv=(typeof s.fov==='function')?s.fov(k):s.fov;
  /* holding at the end of a stage: keep the shot's own framing and orbit it
     slowly, so the hold is a camera move rather than a freeze */
  if(HOLDING&&!reduce){
    const a=Math.sin(HOLDT*.26)*.20, d=fr.p.clone().sub(fr.t), r=d.length();
    const cs=Math.cos(a), sn=Math.sin(a);
    fr.p.set(fr.t.x+d.x*cs+d.z*sn, fr.p.y+Math.sin(HOLDT*.19)*r*.035, fr.t.z-d.x*sn+d.z*cs);
    fv-=Math.sin(HOLDT*.17)*1.1;
  }
  if(Math.abs(camera.fov-fv)>1e-4){camera.fov=fv;camera.updateProjectionMatrix();}
  const shake=(reduce?0:(s.follow?1.4:0.5))+(s.shake?bang*9:0)+bang*1.5;
  camera.position.copy(fr.p).add(V3(Math.sin(TT*1.7+i)*shake,Math.cos(TT*2.3+i)*shake,Math.sin(TT*1.1)*shake));
  camera.lookAt(fr.t);
  if(i!==LASTCUT){
    LASTCUT=i;
    const sl=$("slate");
    if(sl){ sl.textContent=String(i+1).padStart(2,"0")+" · "+s.n; sl.classList.remove("flash");void sl.offsetWidth;sl.classList.add("flash"); }
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
let t=0,playing=true,speed=10,last=null,ready=false,dirty=true,raf=0;
let mode="stages",stage=0;
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
  const pl=$("play"); if(pl) pl.textContent=playing&&!HOLDING?"Pause":"Play";
}
function goStage(i,fromStart){
  stage=cl(i,0,STAGES.length-1);
  HOLDING=false; playing=true;
  if(fromStart!==false) t=STAGES[stage].s;
  dirty=true; stageUI(); kick();
}
function nextStage(){
  if(mode!=="stages"){ playing=true; kick(); return; }
  if(!HOLDING){ t=STAGES[stage].e; HOLDING=true; dirty=true; stageUI(); kick(); return; }
  if(stage>=STAGES.length-1){ goStage(0); return; }
  goStage(stage+1);
}
function resize(){
  const w=cv.clientWidth||960, h=Math.round(w*400/960);
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
  if(playing&&!HOLDING){
    t+=dt*speed;
    const lim=mode==="stages"?STAGES[stage].e:TOTAL;
    if(t>=lim){
      t=lim;
      if(mode==="stages"&&stage<STAGES.length-1){ HOLDING=true; HOLDT=0; }
      else if(mode==="stages"){ HOLDING=true; HOLDT=0; }
      else { playing=false; $("play").textContent="Replay"; }
      stageUI();
    }
    dirty=true;
  }
  if(HOLDING&&playing){ HOLDT+=dt*Math.min(speed,2.5); dirty=true; }
  if(dirty){step(t);hud(t);dirty=false;}
  if((playing&&!reduce)||dirty) raf=requestAnimationFrame(frame);
}
function kick(){ last=null; if(!raf) raf=requestAnimationFrame(frame); }
function load(key){
  compile(key);buildStages();SHOTS=shots();chrome();$("log").dataset.sig="";LASTCUT=-1;
  stage=0;HOLDING=false;HOLDT=0;
  if(reduce){t=TOTAL;playing=false;$("play").textContent="Replay";}
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
    seek(f){ t=cl(f,0,1)*TOTAL; playing=false; HOLDING=false; stage=stageAt(t);
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
    hold(){ if(!HOLDING){ t=STAGES[stage].e; HOLDING=true; HOLDT=0; dirty=true; stageUI(); kick(); } },
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
