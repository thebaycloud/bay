/**
 * The batch, as a picture, while it is still happening.
 *
 *   npm run bench:watch -- --batch aug10-fixed
 *   npm run bench:watch -- --batch aug10-fixed --target local --port 4400
 *
 * A batch runs four deploys at once for half an hour and its only rendering was
 * a flat terminal log: four pipelines interleaved into one column, where the
 * question "what is happening to excalidraw right now" cannot be answered
 * without reading every line and holding four stories in your head. Everything
 * needed to draw it properly was already there — the CLI streams the server's
 * narration — and `run.ts` was discarding it into an empty callback.
 *
 * Deliberately its own tiny server rather than a page in the product. The bench
 * is not the product: it must not need a deploy to be watchable, must not add a
 * route to the app it is measuring, and must keep working when the control plane
 * it is pointed at is exactly the thing that is broken. It reads one JSON file
 * that `run.ts` rewrites, and serves it.
 *
 * Read-only and localhost-only. It renders a file this machine already has.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const batch = arg("batch");
const target = arg("target") ?? "prod";
const port = Number(arg("port") ?? 4300);
if (!batch) {
  console.error("pass --batch <name> — the same name the run was started with");
  process.exit(2);
}
const statusFile = join(here, "results", `${batch}-${target}.status.json`);

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bench ${batch}</title>
<style>
  :root {
    --bg:#0d1117; --panel:#151b23; --line:#232c37; --ink:#e6edf3; --dim:#8b949e;
    --pass:#3fb950; --fail:#f85149; --wait:#d29922; --busy:#58a6ff; --idle:#30363d;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex;
           gap:20px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
  .meta { color:var(--dim); font-size:12px; }
  .tally { margin-left:auto; display:flex; gap:14px; font-size:12px; }
  .tally b { font-weight:600; }
  main { padding:14px 20px 40px; display:grid; gap:10px; }
  .row { background:var(--panel); border:1px solid var(--line); border-radius:8px;
         padding:12px 14px; display:grid; gap:9px; }
  .top { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .name { font-weight:600; min-width:150px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line);
           color:var(--dim); text-transform:uppercase; letter-spacing:.06em; }
  .badge.pass{color:var(--pass);border-color:var(--pass)}
  .badge.fail{color:var(--fail);border-color:var(--fail)}
  .badge.busy{color:var(--busy);border-color:var(--busy)}
  .badge.wait{color:var(--wait);border-color:var(--wait)}
  .times { margin-left:auto; color:var(--dim); font-size:12px; display:flex; gap:14px; }
  .times b { color:var(--ink); font-weight:600; }
  /* The stage rail. Each phase is a segment; the one in progress pulses. */
  .rail { display:grid; grid-template-columns:repeat(8,1fr); gap:3px; }
  .seg { height:6px; border-radius:3px; background:var(--idle); position:relative; }
  .seg.done { background:#2d5a3d; }
  .seg.now  { background:var(--busy); animation:pulse 1.4s ease-in-out infinite; }
  .seg.bad  { background:var(--fail); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  .rail-labels { display:grid; grid-template-columns:repeat(8,1fr); gap:3px;
                 font-size:10px; color:var(--dim); letter-spacing:.04em; }
  .line { color:var(--dim); font-size:12px; white-space:nowrap; overflow:hidden;
          text-overflow:ellipsis; }
  .line.bad { color:#ff9a94; white-space:normal; }
  .quiet { color:var(--wait); }
  a { color:var(--busy); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .empty { color:var(--dim); padding:40px 20px; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#ffffff; --panel:#f6f8fa; --line:#d0d7de; --ink:#1f2328; --dim:#636c76; --idle:#d0d7de; }
    .seg.done{background:#aceebb}
  }
</style></head>
<body>
<header>
  <h1 id="title">bench</h1>
  <span class="meta" id="meta"></span>
  <span class="tally" id="tally"></span>
</header>
<main id="rows"><div class="empty">waiting for the batch to say something…</div></main>
<script>
const PHASES = ["reserve","source","detect","plan","build","deploy","repair","live"];
const secs = ms => ms === null || ms === undefined ? "—" : (ms/1000).toFixed(1)+"s";

function railFor(p, now) {
  // Everything up to the current phase is done, the current one pulses. On a
  // finished project the rail freezes: green to the end if it went live, red at
  // the phase it stopped in if it did not — which is the "where did it break"
  // question answered at a glance, per project, across the whole batch.
  const at = p.phase ? PHASES.indexOf(p.phase) : -1;
  const dead = p.state === "done" && p.outcome !== "live";
  return PHASES.map((_, i) => {
    if (at < 0) return "";
    if (i < at) return "done";
    if (i === at) return dead ? "bad" : (p.state === "done" ? "done" : "now");
    return "";
  });
}

function badgeOf(p) {
  if (p.state === "waiting") return ["wait", "waiting " + p.waits + "/20"];
  if (p.state === "probing") return ["busy", "probing"];
  if (p.state === "deploying") return ["busy", p.phase || "deploying"];
  if (p.state === "pending") return ["", "queued"];
  const v = p.verdict || p.outcome || "done";
  const cls = v === "pass" ? "pass" : (v === "live" ? "pass" : (v === "inconclusive" ? "wait" : "fail"));
  return [cls, v];
}

function render(s) {
  document.getElementById("title").textContent = "bench " + s.batch + " · " + s.target;
  const running = s.finishedAt ? "finished" : "running";
  document.getElementById("meta").textContent =
    s.concurrency + " at a time · " + running + " · " + new Date(s.updatedAt).toLocaleTimeString();

  const done = s.projects.filter(p => p.state === "done");
  const good = done.filter(p => p.outcome === "live").length;
  const bad = done.filter(p => p.outcome !== "live").length;
  document.getElementById("tally").innerHTML =
    '<span style="color:var(--pass)"><b>' + good + '</b> live</span>' +
    '<span style="color:var(--fail)"><b>' + bad + '</b> not</span>' +
    '<span style="color:var(--dim)"><b>' + (s.projects.length - done.length) + '</b> to go</span>';

  const now = Date.now();
  document.getElementById("rows").innerHTML = s.projects.map(p => {
    const [cls, label] = badgeOf(p);
    const rail = railFor(p, now);
    const elapsed = p.state === "done" || !p.startedAt ? null : now - p.startedAt;
    const bad = p.state === "done" && p.outcome !== "live";
    // How long the deploy has said nothing. On the production path this reaches
    // about two minutes right after the upload, every single time: the control
    // plane hands the work to a Cloud Run Job and there is nothing to report
    // until that job starts. Shown because a running deploy that has been quiet
    // for 90 seconds and a page that has stopped updating look identical, and
    // one of them is the handoff cost this whole harness exists to measure.
    const quiet = p.state === "deploying" && p.lastLineAt ? now - p.lastLineAt : null;
    const say = p.state === "done" ? (p.cause || "") : (p.line || "");
    return '<div class="row">' +
      '<div class="top">' +
        '<span class="name">' + p.key + '</span>' +
        '<span class="badge ' + cls + '">' + label + '</span>' +
        (p.url ? '<a href="' + p.url + '" target="_blank" rel="noreferrer">' + (p.slug||'') + '</a>' : '') +
        '<span class="times">' +
          (elapsed !== null ? '<span>elapsed <b>' + secs(elapsed) + '</b></span>' : '') +
          (p.reservedMs != null ? '<span>url <b>' + secs(p.reservedMs) + '</b></span>' : '') +
          (p.activatedMs != null ? '<span>live <b>' + secs(p.activatedMs) + '</b></span>' : '') +
          (p.firstOkMs != null ? '<span>answering <b>' + secs(p.firstOkMs) + '</b></span>' : '') +
        '</span>' +
      '</div>' +
      '<div class="rail">' + rail.map(c => '<div class="seg ' + c + '"></div>').join('') + '</div>' +
      '<div class="rail-labels">' + PHASES.map(x => '<span>' + x + '</span>').join('') + '</div>' +
      (say ? '<div class="line' + (bad ? ' bad' : '') + '">' + esc(say) +
        (quiet !== null && quiet > 8000
          ? ' <span class="quiet">· silent ' + Math.round(quiet/1000) + 's</span>' : '') +
        '</div>' : '') +
    '</div>';
  }).join("");
}

function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}

async function tick() {
  try {
    const r = await fetch("/state", { cache: "no-store" });
    if (r.ok) render(await r.json());
  } catch (e) { /* the batch may not have written anything yet */ }
}
tick();
setInterval(tick, 1000);
</script>
</body></html>`;

createServer((req, res) => {
  if (req.url === "/state") {
    if (!existsSync(statusFile)) { res.writeHead(404).end("{}"); return; }
    try {
      const body = readFileSync(statusFile, "utf8");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
    } catch {
      // Caught mid-rename, which `Status` makes vanishingly unlikely and does not
      // make impossible. The page retries in a second; an error page would be a
      // worse answer than the previous frame staying up.
      res.writeHead(503).end("{}");
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
}).listen(port, "127.0.0.1", () => {
  console.log(`watching ${statusFile}`);
  console.log(`open http://127.0.0.1:${port}`);
  if (!existsSync(statusFile)) console.log(`(no status file yet — start the batch and it will appear)`);
});
