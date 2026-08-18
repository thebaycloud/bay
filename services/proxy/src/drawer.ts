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

/* ===========================================================================
   Tokens implied by components/ds/*. The merge brought the components and not
   the theme, so they are written out here until the real @theme block lands.
   Icons are lucide v0.454 path data, lifted from the installed package.
   Buttons are the real two-surface component: metal plates from
   apps/web/public/metal, a lit top edge, and a label that rolls.
   =========================================================================== */
:host{
  --white:#FFFFFF; --ground:#E5E5E2; --tile:#F1F1EE;
  --tint:#FCEEEA;         /* machine values sit on this and nothing else does */
  --ink:#1A1A19; --ink-2:#5A5A58; --ink-3:#8A8A86;
  --line:#E5E5E2;
  --red:#E63F2C; --red-deep:#B32C1A;
  --red-ink:#B32C1A;      /* brand red is 3.58:1 on tint — text uses this */
  --green:#158043;
  --sans:'Geist',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace;
  --r-xl:12px; --r-lg:8px; --r-sm:3px;
  --ease:cubic-bezier(.2,.8,.2,1);
  --w:640px;
  font-family:var(--sans);font-size:15px;line-height:1.4;color:var(--ink);
  -webkit-font-smoothing:antialiased;
}
*{box-sizing:border-box}

.t-section{font-size:18px;font-weight:500;letter-spacing:-.02em;line-height:1.25}
.t-sub{font-size:13.5px;color:var(--ink-2);line-height:1.45}
.t-micro{font-family:var(--mono);font-size:12px;color:var(--ink-2)}
.t-label{font-family:var(--mono);font-size:11px;letter-spacing:.09em;
         text-transform:uppercase;color:var(--ink-3)}
svg{display:block;flex:none}


/* =============================== the drawer ============================== */
.drawer{position:fixed;top:0;right:0;bottom:0;width:var(--w);z-index:61;
        background:var(--ground);border-left:1px solid var(--line);
        display:flex;flex-direction:column;overflow:hidden}
.drawer[hidden]{display:none}
.grip{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:3}
.grip:hover::after,.grip.on::after{content:'';position:absolute;left:2px;top:0;bottom:0;
                                   width:2px;background:var(--red)}
.head{display:flex;align-items:center;justify-content:space-between;gap:10px;
      padding:0 12px 0 16px;height:56px;flex:none;background:var(--white);z-index:2}
.head-l,.head-r{display:flex;align-items:center;gap:10px;min-width:0}
.slug{font-size:16px;font-weight:600;letter-spacing:-.03em}
.nav{display:inline-flex;align-items:center;gap:6px;background:none;border:0;cursor:pointer;
     color:var(--ink);font-family:var(--sans);font-size:16px;font-weight:600;
     letter-spacing:-.03em;padding:8px 10px 8px 4px;margin-left:-6px;border-radius:var(--r-lg)}
.nav:hover{background:var(--tile)}
.nav:focus-visible{outline:2px solid var(--red);outline-offset:-2px}
.nav svg{color:var(--red)}
.state{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);
       font-size:12px;color:var(--ink-2);white-space:nowrap}
.state b{width:6px;height:6px;border-radius:50%;display:block;background:var(--ink-3)}
.state.ok b{background:var(--green)}
.state.warn b{background:var(--red)}
.state.load b{background:var(--red);animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

.scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;background:var(--ground);
        container-type:inline-size}
.scroll.push{animation:push .17s ease}
.scroll.pop{animation:pop .17s ease}
@keyframes push{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}

/* ====================== squared cells, rounded parts ===================== */
/* Two across, because a crossing needs four cells to meet. A single column
   only ever pinches along an edge — half the detail, and the wrong half. */
/* The grid cannot grow a row to fill leftover height without knowing the row
   count, so the page is a flex column: the fixed cells, then one that takes
   whatever is left. Both sit on the same ground, so the hairline rule holds. */
.home{display:flex;flex-direction:column;gap:1px;background:var(--ground);
      padding:1px 1px 0;min-height:100%}
.cells{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--ground);
       align-content:start}
.cell.grow{flex:1;display:flex;flex-direction:column;min-height:190px}
.cell.wide{grid-column:1 / -1}
/* The drawer is resizable, so this has to answer to the drawer and not the
   viewport: below the width where a pair still reads, everything goes full. */
@container (max-width: 392px){ .cells{grid-template-columns:1fr} }
.cell{position:relative;display:flex;flex-direction:column;gap:4px;
      border-radius:var(--r-xl);background:var(--white);padding:18px 18px 20px;
      text-align:left;border:0;font-family:inherit;color:inherit;width:100%}
button.cell{cursor:pointer}
button.cell:hover{background:#FCFCFB}
button.cell:focus-visible{outline:2px solid var(--red);outline-offset:-2px}
.cell .go{position:absolute;top:19px;right:18px;color:var(--ink-3)}
button.cell:hover .go{color:var(--red)}
.cell .part{margin-top:14px}
.cell:not(.wide){padding:16px 16px 18px}
.cell:not(.wide) .part{margin-top:auto;padding-top:14px}
.cell.tinted{background:var(--tint)}
.cell.tinted .t-section{color:var(--red-ink)}

/* the value row: machine strings live here and nowhere else */
.tint{display:flex;align-items:center;gap:6px;height:48px;border-radius:var(--r-xl);
      background:var(--tint);padding:0 6px 0 12px}
.tint .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
         font-family:var(--mono);font-size:13px;color:var(--red-ink);padding-right:6px}
.icon{width:32px;height:32px;flex:none;display:grid;place-items:center;border-radius:var(--r-lg);
      border:0;background:none;color:var(--ink-2);cursor:pointer;
      transition:background-color .15s var(--ease)}
.icon:hover{background:rgba(26,26,25,.05)}
.icon:focus-visible{outline:2px solid var(--red);outline-offset:1px}

/* ---------------------------- the real button --------------------------- */
/* Two surfaces that cross-fade: what it is at rest, and what it is under the
   cursor. Metal is a plate image, magnified on X only so the vertical grain
   fattens while the top-to-bottom ramp stays inside the box — that ramp is what
   puts the lit edge on top and the shadow underneath. The label rolls rather
   than fading: two copies share a cell, the live one leaves through the top and
   its duplicate arrives from below. */
.btn{position:relative;isolation:isolate;display:inline-flex;align-items:center;
     justify-content:center;overflow:hidden;border:0;cursor:pointer;
     font-family:var(--sans);font-weight:500;letter-spacing:-.01em;
     transition:color .2s,box-shadow .2s,background-color .2s}
.btn:focus-visible{outline:2px solid var(--red);outline-offset:2px}
.btn.sm{height:32px;padding:0 12px;font-size:13.5px;border-radius:var(--r-lg)}
.btn.md{height:40px;padding:0 16px;font-size:13.5px;border-radius:var(--r-lg)}
.btn.lg{height:48px;padding:0 24px;font-size:15px;border-radius:var(--r-xl)}
.btn .ghost{visibility:hidden;display:inline-flex;align-items:center;white-space:nowrap}
.btn .roll{position:absolute;inset:0;z-index:10;display:flex;align-items:center;
           justify-content:center;white-space:nowrap;
           transition:transform .3s var(--ease)}
.btn .roll.b{transform:translateY(100%)}
.btn:hover .roll.a{transform:translateY(-100%)}
.btn:hover .roll.b{transform:translateY(0)}
.btn.sm .ghost,.btn.sm .roll{gap:6px}
.btn.md .ghost,.btn.md .roll{gap:8px}
.btn.lg .ghost,.btn.lg .roll{gap:10px}

/* a hairline edge belongs to white only; metal draws its own */
.btn.r-white{background:var(--white);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
.btn.r-steel{background:var(--white);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(26,26,25,.2)}
.btn.r-red{background:var(--white);color:#fff;box-shadow:inset 0 0 0 1px var(--red-deep)}
.btn.h-white:hover{color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
.btn.h-steel:hover{color:var(--ink);box-shadow:inset 0 0 0 1px rgba(26,26,25,.2)}
.btn.h-red:hover{color:#fff;box-shadow:inset 0 0 0 1px var(--red-deep)}

.plate{position:absolute;inset:0;background-position:center;background-repeat:no-repeat;
       background-size:300% 100%;pointer-events:none;transition:opacity .2s}
.plate.steel{filter:brightness(1.2)}
.plate.rest{opacity:1}
.btn.fades:hover .plate.rest{opacity:0}
.plate.to{opacity:0}
.btn:hover .plate.to{opacity:1}
/* the lit top edge sells metal as a pressable object; it fades with the surface */
.lit{position:absolute;left:0;right:0;top:0;height:1px;background:rgba(255,255,255,.45);
     pointer-events:none;transition:opacity .2s}
.lit.off{opacity:0}
.btn:hover .lit.on-hover{opacity:1}
.btn:hover .lit.off-hover{opacity:0}

.avs{display:flex}
.av{width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:50%;
    border:1.5px solid var(--white);background:var(--tile);font-family:var(--mono);
    font-size:10px;color:var(--ink-2)}
.av + .av{margin-left:-8px}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}
.dot.red{background:var(--red)} .dot.green{background:var(--green)}
.chips{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px}

/* ------------------------------- a screen -------------------------------- */
/* A screen is the same ruled surface as home — cells on the ground — rather
   than a bare table dropped under a heading. Uppercase mono headings are gone:
   at 11px with letter-spacing they read as chrome, and mono belongs to machine
   values, not to the word "People". */
.screen{background:var(--ground);min-height:100%;display:flex;flex-direction:column;
        gap:1px;padding:1px 1px 0}
.pad{background:var(--white);border-radius:var(--r-xl);padding:18px}
.pad.grow{flex:1}
.pad + .pad{margin-top:0}
.sec-h{font-size:13.5px;font-weight:500;color:var(--ink-2);margin:0 0 2px}
.sec-n{font-size:12.5px;color:var(--ink-3);margin:0 0 14px;line-height:1.45}

/* one row: something to look at on the left, the fact on the right */
.list{display:flex;flex-direction:column}
.li{position:relative;display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;
    align-items:center;padding:11px 10px;margin:0 -10px;border-radius:var(--r-lg);
    background:none;border:0;width:calc(100% + 20px);text-align:left;color:inherit;
    font-family:inherit;transition:background-color .13s var(--ease)}
button.li{cursor:pointer}
button.li:hover{background:var(--tile)}
button.li:focus-visible{outline:2px solid var(--red);outline-offset:-2px}
.li + .li::before{content:'';position:absolute;left:10px;right:10px;top:0;height:1px;
                  background:var(--line)}
.li:hover::before,.li:hover + .li::before{background:transparent}
.li .lead{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:8px;
          background:var(--tile);color:var(--ink-2);font-family:var(--mono);font-size:10.5px}
.li .lead.round{border-radius:50%}
.li .lead.warm{background:var(--tint);color:var(--red-ink)}
.li .tt{min-width:0}
.li .n1{font-size:14px;font-weight:500;letter-spacing:-.01em;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap}
.li .n2{font-size:12px;color:var(--ink-3);margin-top:1px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap}
.li .val{font-family:var(--mono);font-size:12.5px;color:var(--ink-2);text-align:right;
         white-space:nowrap;font-variant-numeric:tabular-nums}
.li .val.bad{color:var(--red-ink)} .li .val.good{color:var(--green)}
.li .caret{color:var(--ink-3);display:flex}
button.li:hover .caret{color:var(--red)}
/* how big this row is against the biggest — a proportion, not a chart */
.li .prop{position:absolute;left:10px;right:10px;bottom:6px;height:2px;border-radius:2px;
          background:var(--line);overflow:hidden}
.li .prop i{position:absolute;inset:0 auto 0 0;background:var(--red);opacity:.5;display:block}
.li.has-prop{padding-bottom:16px}

/* a pill that carries an outcome */
.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;
      border-radius:999px;font-family:var(--mono);font-size:11px;background:var(--tile);
      color:var(--ink-2)}
.pill.good{background:#EAF4EE;color:var(--green)}
.pill.bad{background:var(--tint);color:var(--red-ink)}
.pill.live{background:var(--tint);color:var(--red-ink)}
.pill.live i{width:5px;height:5px;border-radius:50%;background:var(--red);
             animation:pulse 1.5s ease-in-out infinite}

/* a real control, not a row of text */
.seg{display:flex;gap:1px;background:var(--line);padding:1px;border-radius:10px;margin-top:4px}
.seg button{flex:1;height:34px;border:0;background:var(--white);cursor:pointer;
            font-family:var(--sans);font-size:13px;font-weight:500;color:var(--ink-2)}
.seg button:first-child{border-radius:9px 0 0 9px}
.seg button:last-child{border-radius:0 9px 9px 0}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--white)}
.seg button:focus-visible{outline:2px solid var(--red);outline-offset:-2px}
.seg-n{font-size:12px;color:var(--ink-3);margin:8px 0 0;line-height:1.5}

.none{font-size:13.5px;color:var(--ink-2);margin:6px 0 0;line-height:1.55}
.block{border-radius:var(--r-xl);background:var(--tint);padding:16px;margin-top:14px;
       display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.block p{margin:0;font-size:16px;font-weight:500;letter-spacing:-.02em;line-height:1.35;
         color:var(--red-ink)}
.block small{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);line-height:1.6}
.brief{width:100%;height:150px;background:var(--white);border:0;
       box-shadow:inset 0 0 0 1px rgba(26,26,25,.12);border-radius:var(--r-lg);padding:11px;
       font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--ink);resize:vertical}
/* the merged stream */
.filters{display:flex;gap:5px;flex-wrap:wrap;margin-top:12px}
.filters button{font-family:var(--mono);font-size:11.5px;background:none;border:0;
                box-shadow:inset 0 0 0 1px var(--line);color:var(--ink-3);
                padding:4px 11px;border-radius:999px;cursor:pointer;
                transition:box-shadow .15s,color .15s,background-color .15s}
.filters button:hover{color:var(--ink)}
.filters button[aria-pressed="true"]{background:var(--ink);color:var(--white);box-shadow:none}
.filters button:focus-visible{outline:2px solid var(--red);outline-offset:1px}

.feed{margin-top:14px;flex:1;overflow:hidden;display:flex;flex-direction:column}
.feed .f{display:grid;grid-template-columns:50px 1fr auto;gap:12px;align-items:baseline;
         padding:8px 0;border-bottom:1px solid var(--line);font-family:var(--mono);
         font-size:12.5px;color:var(--ink-2);font-variant-numeric:tabular-nums;
         animation:arrive .3s var(--ease)}
.feed .f:last-child{border-bottom:0}
/* Lower case on purpose: five source tags set in spaced capitals turn a log
   into chrome, and these are meant to be read past, not announced. */
.feed .src{font-size:11.5px;color:var(--ink-3)}
.feed .f.edge  .src{color:#4A6FA5}
.feed .f.web   .src{color:#4F8A62}
.feed .f.api   .src{color:#8060A0}
.feed .f.db    .src{color:#A0713F}
.feed .f.redis .src{color:#A05252}
.feed .msg{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed .meta{text-align:right;white-space:nowrap}
.feed .f.bad .msg,.feed .f.bad .meta{color:var(--red-ink)}
.feed .f.cont .msg{color:var(--ink-2);padding-left:14px}
@keyframes arrive{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}

/* analytics: numbers a person can have an opinion about */
.stats{display:grid;grid-template-columns:1fr 1fr;gap:20px 20px}
.stat .n{font-size:26px;font-weight:500;letter-spacing:-.035em;font-variant-numeric:tabular-nums;
         line-height:1.1}
.stat .l{font-size:12.5px;color:var(--ink-2);margin-top:3px}
.stat .d{font-family:var(--mono);font-size:11.5px;margin-top:5px;color:var(--green)}
.stat .d.down{color:var(--red-ink)}
.bars{display:flex;flex-direction:column;gap:6px}
.bars .r{display:grid;grid-template-columns:1fr 52px;gap:12px;align-items:center;font-size:13px}
.bars .track{position:relative;height:30px;border-radius:var(--r-lg);overflow:hidden;
             background:var(--tile);display:flex;align-items:center}
.bars .fill{position:absolute;inset:0 auto 0 0;background:var(--tint)}
.bars .t{position:relative;padding-left:10px;color:var(--ink);overflow:hidden;
         text-overflow:ellipsis;white-space:nowrap}
.bars .c{text-align:right;color:var(--ink-2);font-family:var(--mono);font-size:12.5px;
         font-variant-numeric:tabular-nums}

.dock{border-radius:var(--r-xl);background:var(--tile);padding:15px;font-family:var(--mono);
      font-size:12.5px;color:var(--ink-2)}
.dock .now{color:var(--ink);display:flex;align-items:center;gap:9px}
.dock .past{opacity:.55;margin-top:7px}

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
/* --------------------------- one white sheet ----------------------------- */
/* The panel was white cells floating on a grey ground, and the ground showed
   through the 1px gaps as the lines between them. That reads well on a page of
   its own and badly over somebody's app: a grey slab beside their white page
   looks like a thing that failed to load, and the emptiness under a short home
   was the largest grey in it.

   So the sheet is white and the LINES stay. The gap is still one pixel; what is
   behind it is now the line colour rather than a whole background, which is why
   .cells keeps a background at all. Screens draw their separators as borders
   instead, because a screen fills its height and would otherwise put the ground
   back underneath the last section. */
.drawer,.scroll{background:var(--white)}
.cells{background:var(--line)}
.screen{background:var(--white);gap:0}
.pad + .pad{border-top:1px solid var(--line)}
.head{border-bottom:1px solid var(--line)}

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

`;

export const DRAWER_JS = String.raw`
var ICONS = {"eye":"<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>","copy":"<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>","arrow-right":"<path d=\"M5 12h14\"/><path d=\"m12 5 7 7-7 7\"/>","plus":"<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>","refresh-cw":"<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/><path d=\"M8 16H3v5\"/>","chevron-right":"<path d=\"m9 18 6-6-6-6\"/>","chevron-left":"<path d=\"m15 18-6-6 6-6\"/>","x":"<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>","trash-2":"<path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/><line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/><line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>","link":"<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>"};

var SVGNS='http://www.w3.org/2000/svg';
function icon(name,size){
  var s=document.createElementNS(SVGNS,'svg');
  s.setAttribute('width',size||16); s.setAttribute('height',size||16);
  s.setAttribute('viewBox','0 0 24 24'); s.setAttribute('fill','none');
  s.setAttribute('stroke','currentColor'); s.setAttribute('stroke-width','2');
  s.setAttribute('stroke-linecap','round'); s.setAttribute('stroke-linejoin','round');
  s.setAttribute('aria-hidden','true');
  s.innerHTML=ICONS[name];
  return s;
}

/* Which finish each tone takes: steel gets panoramic (broad irregular banding
   gives a grey button something to look at), red gets the quieter brushed. */
var PLATE={steel:C.app+'/metal/panoramic-steel.webp', red:C.app+'/metal/brushed-red.webp'};

var DW_DIMS=[['pages','Most opened'],['entry','Where they came in'],['exit','Where they left'],['from','How they got here'],['country','Country'],['region','Region'],['city','City'],['browser','Browser'],['os','Operating system'],['on','Device'],['screen','Screen size'],['language','Language'],['titles','By page title'],['query','Search terms'],['hosts','Which address they used'],['event','Events'],['tag','Tags']];

var TITLES = {analytics:'Analytics', ships:'Ships', data:'Data', keys:'Keys', access:'Access', infra:'Infra', agent:'Agent'};

function dwTop(){ return dwStack.length ? dwStack[dwStack.length-1] : null; }
function dwPush(v){ dwStack.push(v); dwDir='push'; dwRender(); }
function dwPop(){ dwStack.pop(); dwDir='dwPop'; dwRender(); }

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
  var infraPart=el('div','chips');
  infraPart.appendChild(statusChip(d.feed.length ? d.feed.length+' live' : 'quiet',
                                   d.alert ? 'red' : 'green'));
  if(d.jobs.length) infraPart.appendChild(statusChip(d.jobs.length+(d.jobs.length===1?' job':' jobs'),'green'));
  g.appendChild(cell('Infra','What it is doing, and what runs on its own',
    infraPart, function(){ dwPush({v:'infra'}); }));

  g.appendChild(cell('Access','Who can open this', pPart, function(){ dwPush({v:'access'}); }));


  var agPart=el('div','chips');
  var agLast=dwLastAgent(d);
  agPart.appendChild(statusChip(
    agLast!==null ? 'connected' : (d.tokens.length ? 'never used' : 'not connected'),
    agLast!==null ? 'green' : 'red'));
  g.appendChild(cell('Agent',
    agLast!==null ? 'A token last reached us '+ago(Math.round((Date.now()-agLast)/1000))
                  : d.tokens.length ? 'You have a token; nothing has used it yet'
                  : 'Give your coding agent a way in',
    agPart, function(){ dwPush({v:'agent'}); }, true));

  var wrap=el('div','home');
  wrap.appendChild(g);
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

  var present=SOURCES.filter(function(s){ return all.some(function(r){ return r[0]===s; }); });
  var bar=el('div','filters');
  if(present.length>1) present.forEach(function(src){
    var b=el('button',null,src);
    b.setAttribute('aria-pressed', feedOn[src] ? 'true':'false');
    b.addEventListener('click',function(ev){
      ev.stopPropagation();
      feedOn[src]=!feedOn[src];
      dwRender();
    });
    bar.appendChild(b);
  });
  if(present.length>1) c.appendChild(bar);

  var rows=all.filter(function(r){ return feedOn[r[0]]; });
  var feed=el('div','feed');
  c.appendChild(feed);
  if(!rows.length){
    feed.appendChild(el('p','none','Nothing from those. Turn one back on.'));
    return c;
  }

  function paint(list){
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
  return c;
}

/** A labelled bar row — the only chart shape here, and it needs no time axis. */

function screen(view,d){
  var w=el('div','screen'), key=view.v;

  // ------------------------------------------------------------- analytics
  if(key==='analytics'){
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
                        : 'Reading…',
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
      var rp=pad(view.t,'The newest rows.');
      var host=el('div'); rp.appendChild(host); w.appendChild(rp);
      host.appendChild(el('div','sec-n','Reading…'));
      dwApi('/db?table='+encodeURIComponent(view.t)).then(function(j){
        host.innerHTML='';
        if(j.error||!j.rows){ host.appendChild(el('div','sec-n',j.error||'Nothing to read.')); return; }
        if(!j.rows.length){ host.appendChild(el('div','sec-n','This table is empty.')); return; }
        host.appendChild(listOf(j.rows.slice(0,25).map(function(row){
          var ks=j.columns||Object.keys(row);
          return li({lead:'#',title:String(row[ks[0]]),
                     meta:ks.slice(1,3).map(function(k){return k+': '+row[k]}).join(' · '),
                     val:''});
        })));
      });
      return w;
    }
    if(!d.tables.length){
      w.appendChild(pad('Nothing stored yet','Your app has not written anything down.'));
      return w;
    }
    var max=d.tables.reduce(function(m,t){return Math.max(m,t[1]);},1);
    var tp=pad('Your data', d.tables.length+' tables. The bar is how much of your data each one is.');
    tp.appendChild(listOf(d.tables.map(function(t){
      return li({lead:'\u25A6', title:t[0],
                 meta:t[1] ? 'has rows' : 'never written to',
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
      // Reachable only from a stale stack: the list below makes a row tappable
      // only when it has a detail to show, and nothing builds one yet.
      if(!k||!k.detail){ w.appendChild(pad('Nothing more','We have no reading on this key yet.')); return w; }
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
      b.addEventListener('click',function(){
        var was=d.who; d.who=o[0]; dwRender();
        dwPost('/share',{visibility:o[0]}).then(function(j){
          if(j&&j.visibility){ d.who=j.visibility; d.people=j.grants||[]; }
          else d.who=was;
          dwRender();
        });
      });
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
    inv.addEventListener('click',function(){
      var em=prompt('Email of the person who may open this app');
      if(!em) return;
      dwPost('/share',{addEmail:em}).then(function(j){
        if(j&&j.grants){ d.people=j.grants; d.pInitials=j.grants.map(ini); d.who=j.visibility||d.who; }
        dwRender();
      });
    });
    inv.style.marginTop=d.people.length?'14px':'4px';
    pp2.appendChild(inv);
    w.appendChild(pp2);

    var ap=pad('Address','Where it lives. Send this to anyone.');
    ap.appendChild(tintRow(d.addr));
    w.appendChild(ap);

    var dp2=pad('Delete','The app, its data and its files. There is no undo.');
    var del=btn('Delete this app','trash-2',{rest:'white',hover:'red',size:'md'});
    del.addEventListener('click',function(){
      if(prompt('Type the app name to delete it. This cannot be undone.')!==d.slug) return;
      dwPost('/delete',{}).then(function(){ location.href=C.app; });
    });
    dp2.appendChild(del);
    w.appendChild(dp2);
  }

  if(key==='infra') return infraScreen(w,d);
  if(key==='agent') return agentScreen(w,d);

  return w;
}

function infraScreen(w,d){
  // The feed first: it is the half that changes while you are looking at it.
  // rightNowCell brings its own poll, and closing the panel clears it.
  w.appendChild(rightNowCell(d));
  if(!d.jobs.length){
    w.appendChild(pad('Nothing scheduled','Nothing runs on its own yet.'));
    return w;
  }
  var jp=pad('On a schedule','What runs without anyone asking.');
  jp.appendChild(listOf(d.jobs.map(function(j){
    var name=j.name||j.id||'job', bad=j.state&&j.state!=='ENABLED';
    return li({lead:'\u25F4',warm:bad,title:name,meta:j.schedule||'no schedule',
               pill:pill(bad?(j.state||'paused'):'on', bad?'bad':'good')});
  })));
  w.appendChild(jp); return w;
}

var DW_TOOLS=[['claude-code','Claude Code',false],['cursor','Cursor',true],['codex','Codex',false],['claude','Claude',true],['chatgpt','ChatGPT',true],['other','Other',false]];
var dwTool='claude-code';

function agentScreen(w,d){
  var tp=pad('Which tool','It all goes through the CLI. Some can also talk to us directly.');
  var seg=el('div','seg');
  DW_TOOLS.forEach(function(t){
    var b=el('button',null,t[1]);
    b.setAttribute('aria-pressed', dwTool===t[0] ? 'true':'false');
    b.addEventListener('click',function(){ dwTool=t[0]; dwRender(); });
    seg.appendChild(b);
  });
  tp.appendChild(seg);
  w.appendChild(tp);

  var tool=DW_TOOLS.filter(function(t){ return t[0]===dwTool; })[0];

  // Always the CLI: it is what ships, whatever is driving it.
  var ip=pad('Install it','Once per machine.');
  ip.appendChild(tintRow('npm i -g @supersonic/cli'));
  w.appendChild(ip);
  var lp=pad('Sign in','Opens a browser once, then the agent has a token.');
  lp.appendChild(tintRow('supersonic login'));
  w.appendChild(lp);
  var dp=pad('Ship this app','From the folder the code is in.');
  dp.appendChild(tintRow('supersonic deploy --app '+d.slug));
  w.appendChild(dp);

  if(tool && tool[2]){
    // Said plainly rather than shipped half-built. A config block here would
    // point a working tool at a server that does not exist.
    w.appendChild(pad('Talking to us directly',
      tool[1]+' can hold a connection to us as well as run the CLI. That is not\n built yet — when it is, the setup for it appears here.'));
  }

  var kp=pad('Tokens', d.tokens.length ? 'One token deploys everything you own, so this is the last time each was used at all — not on this app.' : 'You have not made one yet. Run the sign-in above and it appears here.');
  if(d.tokens.length){
    kp.appendChild(listOf(d.tokens.map(function(t){
      var used=t.last_used_at ? Date.parse(t.last_used_at) : NaN;
      var rm=btn('Revoke','trash-2',{rest:'white',hover:'red',size:'sm'});
      rm.addEventListener('click',function(){
        if(!confirm('Revoke this token? Any agent using it stops being able to ship.')) return;
        dwPost('/agent',{revoke:t.id}).then(function(j){
          if(j&&j.tokens){ d.tokens=j.tokens; dwRender(); }
        });
      });
      return li({lead:'\u2691', title:t.name||'unnamed token',
                 meta:isFinite(used) ? 'last used '+ago(Math.round((Date.now()-used)/1000)) : 'never used',
                 pill:rm});
    })));
  }
  w.appendChild(kp);
  return w;
}

function headingFor(view,d){
  if(view.v==='ships' && view.i!=null) return d.ships[view.i].when;
  if(view.v==='data'  && view.t)       return view.t;
  if(view.v==='keys'  && view.i!=null) return d.keys[view.i].name;
  return TITLES[view.v];
}


/**
 * How long ago, in the shortest true form.
 *
 * Lifted out of xray-panel.ts when that module was deleted. The panel used two
 * functions from twelve kilobytes of dark-themed code it otherwise shipped to
 * every owner on every page load and never rendered a pixel of; these are the
 * two. ago() is defined through dur() rather than beside it so the two cannot
 * disagree about where an hour ends.
 */
function dur(sec){ if(sec<60)return sec+'s'; if(sec<3600)return Math.round(sec/60)+'m'; if(sec<86400)return Math.round(sec/3600)+'h'; return Math.round(sec/86400)+'d'; }
function ago(sec){ return dur(sec)+' ago'; }

/* ---- the whole umami reading, fetched when the screen asks for it ---- */

var DW_RANGES=[['1d','Today'],['7d','7 days'],['30d','30 days'],['1y','Year']];
var dwRange='1d', dwDetail=null, dwDetailFor=null, dwDetailOn=true, dwDetailReq=null;

/**
 * Every dimension umami will answer for, over one window.
 *
 * Owner-only and same-origin, so no CORS and no bearer: /_dashboard/analytics is
 * answered by the proxy in front of this very app. Deliberately NOT part of
 * dwLoad — that fires on every panel open and this is twenty-odd admin queries
 * against an instance sized for a 2KB tracker. It happens when somebody opens
 * Analytics, once per window, and nothing polls it.
 */
function dwStats(range, force){
  if(!force && dwDetailFor===range && dwDetail!==null) return Promise.resolve(dwDetail);
  if(dwDetailReq && !force) return dwDetailReq;
  dwDetailReq = dwSoon(
    fetch('/_dashboard/analytics?range='+encodeURIComponent(range),
          {credentials:'include',headers:{Accept:'application/json'}})
      .then(function(r){ return r.json(); }),
    // Longer than the server's own 12s budget for this read. Giving up first
    // would show 'that did not come back' about an answer already on its way.
    20000, null
  ).then(function(j){
    dwDetailReq=null; dwDetailFor=range;
    dwDetail = j ? j.detail : null;
    dwDetailOn = j ? !!j.on : false;
    return dwDetail;
  });
  return dwDetailReq;
}

/**
 * The window's shape, as columns.
 *
 * The only chart in the panel, and it earns it: a series is the one reading here
 * that means nothing as a list. Deliberately unlabelled on the x — the window
 * says what the span is, and axis ticks at this size are chrome.
 */
function spark(series){
  var w=el('div','spark');
  var max=series.reduce(function(m,p){ return Math.max(m,p.views); },1);
  series.forEach(function(p){
    var col=el('div','col');
    var fill=el('div','f');
    fill.style.height=Math.max(2, Math.round((p.views/max)*100))+'%';
    col.appendChild(fill);
    col.title=p.t+' - '+p.views+(p.views===1?' view':' views')+', '+p.sessions+(p.sessions===1?' visit':' visits');
    w.appendChild(col);
  });
  return w;
}

/**
 * The most recent moment any of this owner's tokens was used.
 *
 * Null when they have none, and null when they have some that have never been
 * used — two states the screen says differently, because "no token" is something
 * to fix and "never used" is something to try.
 */
function dwLastAgent(d){
  var best=null;
  (d.tokens||[]).forEach(function(t){
    if(!t.last_used_at) return;
    var ms=Date.parse(t.last_used_at);
    if(isFinite(ms) && (best===null || ms>best)) best=ms;
  });
  return best;
}

/** A mean session length, said the way a person would say it. */
function dwMins(sec){
  sec=Math.round(Number(sec)||0);
  if(sec<60) return sec+'s';
  var m=Math.floor(sec/60), r=sec%60;
  return r ? m+'m '+r+'s' : m+'m';
}

/** Why a block is showing dashes. One sentence, and it never guesses a number. */
function dwWhyNoNumbers(d){
  if(d.anWindow==='off' || !d.anOn) return 'Analytics is off, so nobody is being counted.';
  if(!d.anReady) return 'Analytics is still being set up for this app.';
  if(d.anWindow==='unreadable') return 'The analytics service could not be reached just now.';
  return 'Nobody has opened it in the last day.';
}

/**
 * Geist, registered on the document rather than in here.
 *
 * A shadow root cannot carry an @font-face: font faces are resolved against the
 * document, and one declared inside a shadow tree is simply ignored. So the
 * face is added to document.fonts and nothing else is - no rule, no class, no
 * stylesheet on the tenant's page. That keeps the one-way promise the shadow
 * root exists for: our styles still cannot reach their app.
 *
 * Cross-origin, and fonts are always fetched in CORS mode, so this depends on
 * the Access-Control-Allow-Origin header on /fonts/* (see apps/web/next.config.mjs).
 * If any of it fails the tokens already name system-ui next, so the panel is
 * merely less pretty, never unstyled.
 */
(function(){
  if(!window.FontFace||!document.fonts) return;
  [['Geist','/fonts/Geist-Variable.woff2'],['Geist Mono','/fonts/GeistMono-Variable.woff2']]
  .forEach(function(f){
    try{
      if(document.fonts.check('12px "'+f[0]+'"')) return;
      var face=new FontFace(f[0],'url("'+C.app+f[1]+'") format("woff2")',
                            {weight:'100 900',display:'swap'});
      face.load().then(function(loaded){ document.fonts.add(loaded); })
                 .catch(function(e){ console.error('panel font:',e); });
    }catch(e){ console.error('panel font:',e); }
  });
})();

// ---- the panel: state ----
//
// 'dwOpen' rather than 'open', 'dwPop' rather than 'pop', 'dwApi' rather than
// 'api': this file is interpolated into OWNER_JS *after* the toolbar, and a
// second 'function api(...)' in that scope silently rebinds the toolbar's own.
// (It did, until this rewrite — Share was posting to '/api/apps/<slug>[object
// Object]' and swallowing the 404.) Names here are prefixed for that reason.
var dw=null,dwScrim=null,dwScroll=null,dwHeadEl=null,dwGrip=null,dwFlat=false;
var dwOpen=false,dwStack=[],dwDir='push',dwFeedTimer=null;
var dwD=null,dwPending=null,dwErr=null;

/**
 * A request that cannot hang the panel.
 *
 * Everything here is fetched at once so home can show a fact per cell, and the
 * first version waited on Promise.all with no deadline anywhere. One of the
 * eight is /_xray, which assembles its reading from Umami - a service
 * reading.ts itself says can be off or unreachable - so one slow answer left
 * the whole panel reading "Reading..." forever, with nothing on screen and
 * nothing in the console. A cell holding a dash is worth more than seven cells
 * that never arrive.
 */
function dwSoon(p,ms,fallback){
  return new Promise(function(resolve){
    var done=false;
    var t=setTimeout(function(){ if(!done){ done=true; resolve(fallback); } },ms||6000);
    p.then(function(v){ if(!done){ done=true; clearTimeout(t); resolve(v); } },
           function(){ if(!done){ done=true; clearTimeout(t); resolve(fallback); } });
  });
}

function dwApi(path,opts){
  // credentials:'include' because this is a DIFFERENT ORIGIN — the panel runs
  // on the app's own hostname and the control plane answers on app.*. The route
  // allows exactly this app's origin and no other subdomain; see lib/cors.ts for
  // the cross-tenant attack that a wider allowlist would open.
  return fetch(C.app+'/api/apps/'+C.slug+path,Object.assign({credentials:'include'},opts||{}))
    .then(function(r){return r.json()})
    .catch(function(e){return {error:String(e)}});
}
function dwPost(path,body){
  return dwApi(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
function dwLive(){
  // The live half is the app's own origin, not the control plane: /_xray is
  // served by the proxy in front of this very app, so it is same-origin and
  // needs no CORS at all.
  return fetch('/_xray',{credentials:'include',headers:{Accept:'application/json'}})
    .then(function(r){return r.json()}).catch(function(){return null});
}

/** Rows out of information_schema come back under names that have changed once
 *  already; read them defensively rather than pinning one spelling. */
function dwTableRow(t){
  var name=t.table_name||t.tablename||t.name||String(t);
  var n=t.n_live_tup!=null?t.n_live_tup:(t.rows!=null?t.rows:0);
  return [name,Number(n)||0];
}
function dwKeyName(k){ return typeof k==='string'?k:(k.key||k.name||String(k)); }

/**
 * Everything the panel shows, fetched at once.
 *
 * Seven requests in parallel and not seven screens each fetching on arrival:
 * home shows a live fact on every cell — how many tables, how many keys, who is
 * here — so a panel that fetched per-screen would open onto six spinners and
 * then still be wrong, because the facts it summarises live behind six
 * different routes. Kicked off before the panel is opened (see the idle call at
 * the end of this file), so the common case is that it is already here.
 */
function dwLoad(force){
  if(dwPending && !force) return dwPending;
  if(dwD && !force) return Promise.resolve(dwD);
  dwPending=Promise.all([
    dwSoon(dwApi('/share'),6000,{}),   dwSoon(dwApi('/env'),6000,{}),
    dwSoon(dwApi('/db'),6000,{}),      dwSoon(dwApi('/storage'),6000,{}),
    dwSoon(dwApi('/jobs'),6000,{}),    dwSoon(dwApi('/deploy-status'),6000,{}),
    dwSoon(dwApi('/analytics'),6000,{}), dwSoon(dwApi('/agent'),6000,{}),
    // Shorter, and first to be given up on: this is the one that reaches Umami.
    dwSoon(dwLive(),4000,null)
  ]).then(function(r){
    var share=r[0]||{},env=r[1]||{},db=r[2]||{},store=r[3]||{},jobs=r[4]||{},
        dep=r[5]||{},an=r[6]||{},agent=r[7]||{},live=r[8];
    var grants=share.grants||[];
    var here=[],feed=[];
    if(live&&live.live){
      var L=live.live;
      (L.here.names||[]).forEach(function(n){ here.push([n,'here now']); });
      var anon=(L.here.count||0)-(L.here.names||[]).length;
      if(anon>0) here.push([anon+(anon===1?' person':' people')+' not signed in','']);
      // One source, honestly. The prototype interleaved edge/web/api/db/redis;
      // the edge is the only one of those the proxy actually hears, so the rest
      // are not drawn rather than drawn empty.
      feed=(L.paths||[]).slice(0,40).map(function(p){
        var tone=p.brokenFor?'bad':'';
        return ['edge',p.path,(p.hits+' · '+p.p50+'ms · '+ago(p.ago)),tone];
      });
    }
    var aud = live && live.audience ? live.audience : null;
    var broken=(live&&live.live?(live.live.paths||[]):[]).filter(function(p){return p.brokenFor});
    var d={
      slug:C.slug,
      addr:C.slug+'.supersonic.cv',
      // The people half. /analytics answers whether analytics is ON; the
      // COUNTING is already read from umami by the proxy and carried in the
      // reading, so this needs no endpoint of its own and no second round trip
      // — it arrives on the same fetch as the live half.
      //
      // Never added to or compared with the live numbers beside it: the edge
      // counts requests and umami counts people, and one page view with eleven
      // assets on it is eleven requests and one visitor. analytics.ts keeps that
      // line at the source and this keeps it here.
      an: aud ? {
        visitors: aud.visitors, views: aud.views,
        mins: dwMins(aud.avgSeconds),
        // Umami gives a bounce rate, not a returning count. The tile says what
        // the number is rather than what the prototype wished it were.
        returning: (Math.round(Number(aud.bounce)||0))+'%',
        dv: aud.change==null ? '' : (aud.change>0?'+':'')+Math.round(aud.change)+'%',
        dvUp: (Number(aud.change)||0) >= 0,
        pages: aud.pages||[], from: aud.from||[], on: aud.on||[]
      } : null,
      anWindow: (live&&live.since) ? live.since.audience : 'off',
      anOn:an.enabled!==false, anReady:Boolean(an.provisioned),
      here:here, initials:here.map(function(x){return ini(x[0])}),
      feed:feed,
      who:share.visibility||'private',
      people:grants, pInitials:grants.map(ini),
      requests:share.requests||[],
      tables:(db.tables||[]).map(dwTableRow),
      files:(store.objects||[]).length,
      missing:db.error||null,
      keys:(env.keys||[]).map(function(k){ return {name:dwKeyName(k),tone:'',st:'set'}; }),
      jobs:jobs.jobs||[],
      // Tokens belong to a person, not to an app: one deploys everything they
      // own. So this is the last time a token was used AT ALL, and the screen
      // says it in those words rather than claiming a per-app fact we do not
      // record.
      tokens:(agent.tokens||[]),
      mcp:Boolean(agent.mcp),
      // deploys.ts: status is live | building | deploying | pending | failed |
      // canceled, and there is no 'done'. Reading stage for doneness would have
      // left every finished app saying "Shipping" forever, because stage holds
      // the last step it ran (deploy, verify, fleet-boot), not whether it ended.
      shipping:['building','deploying','pending'].indexOf(String(dep.deploy&&dep.deploy.status))>=0,
      ships:[],dock:null,
      alert:null
    };
    if(dep.deploy){
      var dd=dep.deploy, st=String(dd.status||'');
      var stamp=dd.finishedAt||dd.updatedAt;
      d.ships=[{
        did:dd.name||dd.stage||'a change',
        when:stamp?ago(Math.round((Date.now()-new Date(stamp).getTime())/1000)):'just now',
        // The row records no actor. An owner is the only person who can see this
        // panel, so naming them is honest; inventing a name would not be.
        who:'you',
        out:st==='live'?'shipped':(st==='failed'||st==='canceled')?'never left':'live',
        status:st, stage:dd.stage||'', error:dd.error||null, url:dd.url||null
      }];
      if(dd.error) d.alert=d.alert||{kind:'bad',icon:'refresh-cw',
        title:'The last ship did not land',sub:String(dd.error).slice(0,160),act:'Look at it'};
    }
    if(!d.ships.length) d.ships=[{did:'first ship',when:'not yet',who:'you',out:'live'}];
    if(broken.length){
      var b=broken[0];
      d.alert={kind:'bad',icon:'refresh-cw',title:b.path+' has been failing for '+dur(b.brokenFor),
               sub:'The edge has seen no success there since.',act:'Look at it'};
    }
    dwD=d; dwErr=null; dwPending=null;
    return d;
  }).catch(function(e){
    // Never swallowed, and never left spinning: the panel says so and
    // offers the retry, which is the only useful thing left to do.
    console.error('panel:',e);
    dwErr=String(e&&e.message||e); dwPending=null; dwD=null;
    return null;
  });
  return dwPending;
}

function dwHeading(){
  var v=dwTop(); if(!v) return null;
  return headingFor(v,dwD);
}

/** Paint the whole panel from 'dwD'. Cheap enough to do on every navigation. */
function dwRender(){
  if(!dw) return;
  clearInterval(dwFeedTimer);
  if(!dwD){
    dwScroll.innerHTML='';
    if(dwErr){
      // Never left spinning. A panel that says "Reading..." forever is
      // indistinguishable from one that is broken, which is what this was.
      var ep=pad('That did not come back','Nothing could be read about this app just now.');
      var again=btn('Try again','refresh-cw',{rest:'white',hover:'steel',size:'sm'});
      again.addEventListener('click',function(){
        dwErr=null; dwRender(); dwLoad(true).then(function(){ dwRender(); });
      });
      ep.appendChild(again);
      dwScroll.appendChild(ep);
    } else {
      dwScroll.appendChild(pad('Reading…','Fetching what your app is doing.'));
    }
    return;
  }
  var d=dwD,view=dwTop();

  dwHeadEl.innerHTML='';
  var Lft=el('div','head-l');
  if(!view){
    Lft.appendChild(el('span','slug',d.slug));
  } else {
    var back=el('button','nav');
    back.appendChild(icon('chevron-left',20));
    back.appendChild(el('span',null,dwHeading()));
    back.addEventListener('click',dwPop);
    Lft.appendChild(back);
  }
  dwHeadEl.appendChild(Lft);

  var R=el('div','head-r');
  var tone=d.alert?'warn':d.shipping?'load':'ok';
  var st=el('span','state '+tone);
  st.appendChild(el('b'));
  st.appendChild(el('span',null,d.alert?'broken':d.shipping?'shipping':'afloat'));
  R.appendChild(st);
  if(!dwFlat){
    var x=el('button','icon');
    x.setAttribute('aria-label','Close');
    x.appendChild(icon('x',18));
    x.addEventListener('click',closeDrawer);
    R.appendChild(x);
  }
  dwHeadEl.appendChild(R);

  dwScroll.innerHTML='';
  dwScroll.appendChild(view ? screen(view,d) : homeScreen(d));
  dwScroll.scrollTop=0;
  dwScroll.classList.remove('push','pop');
  void dwScroll.offsetWidth;
  dwScroll.classList.add(dwDir);
}

/** The panel's shell. 'flat' is the /_xray page, where it IS the page. */
function buildDrawer(flat){
  dwFlat=!!flat;
  dw=el('aside','drawer'+(flat?' flat':''));
  if(!flat){
    dwGrip=el('div','grip');
    dw.appendChild(dwGrip);
    dwGrip.addEventListener('pointerdown',function(e){
      dwGrip.classList.add('on'); dwGrip.setPointerCapture(e.pointerId);
      var move=function(ev){
        var w=Math.min(Math.max(window.innerWidth-ev.clientX,340),Math.min(1040,window.innerWidth-200));
        dw.style.setProperty('--w',w+'px');
      };
      var up=function(){ dwGrip.classList.remove('on');
        dw.removeEventListener('pointermove',move); dw.removeEventListener('pointerup',up); };
      dw.addEventListener('pointermove',move); dw.addEventListener('pointerup',up);
    });
  }
  dwHeadEl=el('div','head'); dw.appendChild(dwHeadEl);
  dwScroll=el('div','scroll'); dw.appendChild(dwScroll);
  dwLoad().then(function(){ dwRender(); });
  dwRender();
  return dw;
}

function openDrawer(){
  if(dw){ closeDrawer(); return; }
  if(typeof pop!=='undefined' && pop){ pop.remove(); pop=null; }
  dwOpen=true; dwStack=[]; dwDir='push';
  dwScrim=el('div','dw-scrim'); dwScrim.addEventListener('click',closeDrawer);
  root.appendChild(dwScrim);
  root.appendChild(buildDrawer(false));
  requestAnimationFrame(function(){ dw.classList.add('on'); dwScrim.classList.add('on'); });
}
function closeDrawer(){
  if(!dw) return;
  clearInterval(dwFeedTimer); dwFeedTimer=null;
  var a=dw,s=dwScrim;
  dw=null; dwScrim=null; dwScroll=null; dwHeadEl=null; dwOpen=false; dwStack=[];
  a.classList.remove('on'); if(s) s.classList.remove('on');
  setTimeout(function(){ a.remove(); if(s) s.remove(); },240);
}

/** Compatibility seam for the /_xray page, which asked for a tab by name back
 *  when this had tabs. Home is the whole panel now, so anything lands there. */
function dwSelect(){ dwStack=[]; dwDir='push'; dwRender(); }

// Warm before it is wanted. requestIdleCallback so it never competes with the
// tenant app's own load; owner-only, so this costs a visitor nothing.
if(window.requestIdleCallback) requestIdleCallback(function(){ dwLoad(); });
else setTimeout(function(){ dwLoad(); },2000);

`;
