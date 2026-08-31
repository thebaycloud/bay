/**
 * The box router — what makes a dev server on this machine reachable at a real
 * Bay address.
 *
 * The edge proxy already fronts every `*.thebay.cloud`, resolves the slug from
 * the Host header, reads the app row, and forwards to whatever `run_url` says,
 * adding `x-supersonic-slug` and the fleet's edge secret on the way (see
 * services/proxy/src/forward.ts). It does not care what is on the other end.
 * So a preview is an app row whose run_url is this box, and this process is the
 * other end: slug in, dev server out.
 *
 * It is deliberately the same shape as services/fleet/agent/router.go, including
 * the part that matters most:
 *
 *   THE SLUG HEADER IS CLIENT-SUPPLIED. Port 8080 answers the open internet —
 *   Cloud Run has no static egress range to firewall down to — so anybody can
 *   send any slug. The edge secret is the whole authorisation: without it a
 *   request is refused before the routing table is consulted at all. Comparing
 *   it in constant time is not ceremony; a byte-at-a-time compare over an open
 *   port is a byte-at-a-time oracle.
 */
const http = require("node:http");
const fs = require("node:fs");
const { timingSafeEqual } = require("node:crypto");

const PORT = Number(process.env.BOX_ROUTER_PORT || 8080);
const ROUTES = process.env.BOX_ROUTES || "/srv/box/routes.json";
const SECRET = (process.env.FLEET_EDGE_SECRET || "").trim();

if (!SECRET) {
  console.error("[router] FLEET_EDGE_SECRET is empty — refusing to start.");
  console.error("[router] Without it every request would be authorised, on a port the internet can reach.");
  process.exit(1);
}

/**
 * The routing table, re-read when the file changes rather than per request.
 *
 * `bay preview` writes this file; a dev server that has just started must be
 * reachable without restarting the router, and a router that stats the file on
 * every request pays for that on every asset of every page.
 */
let routes = {};
function load() {
  try {
    routes = JSON.parse(fs.readFileSync(ROUTES, "utf8"));
    console.log(`[router] routes: ${Object.keys(routes).map((s) => `${s}→${routes[s]}`).join(", ") || "(none)"}`);
  } catch (e) {
    // A missing file is the ordinary state of a box nobody has previewed from
    // yet, not an error. Anything else is worth saying out loud, because the
    // symptom otherwise is a 404 nobody can explain.
    if (e.code !== "ENOENT") console.error(`[router] ${ROUTES}: ${e.message}`);
    routes = {};
  }
}
load();
try {
  fs.watch(ROUTES, { persistent: false }, load);
} catch {
  /* The file may not exist yet; the directory watch below is what catches that. */
}
try {
  fs.watch(require("node:path").dirname(ROUTES), { persistent: false }, load);
} catch {
  /* Not fatal: `bay preview` reloads us by hand when it cannot rely on a watch. */
}

/** Constant-time, and false for a length mismatch rather than throwing on one. */
function secretOk(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  // Both spellings, for the same reason forward.ts sends both: the rename is
  // not finished and an edge deployed either side of it must reach this box.
  const edge = req.headers["x-bay-edge"] || req.headers["x-supersonic-edge"];
  if (!secretOk(edge)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("not the edge\n");
    return;
  }

  // The slug header first, Host second — the same order as the fleet router.
  // The edge always sends the header; Host is the fallback that lets a person
  // curl this box directly while debugging.
  const slug = String(req.headers["x-supersonic-slug"] || req.headers["x-bay-slug"] || "").trim()
    || String(req.headers.host || "").split(":")[0].split(".")[0];

  const port = routes[slug];
  if (!port) {
    res.writeHead(404, { "content-type": "text/plain" })
      .end(`no preview named "${slug}" on this box\n\nRun: bay preview <port> --as ${slug}\n`);
    return;
  }

  const up = http.request(
    { host: "127.0.0.1", port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    // The honest failure. A dev server that is not running is the single most
    // likely thing to be wrong here, and "502" alone sends people to the edge
    // to look for a problem that is on this machine.
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`preview "${slug}" is registered on port ${port}, but nothing is listening there.\n${e.message}\n`);
  });
  req.pipe(up);
});

// A dev server streams: HMR is server-sent events and Vite's client holds one
// open for the life of the page. Node's default 5s header timeout and 2m
// request timeout would cut those, and the symptom is a preview that stops
// updating after two minutes rather than an error anybody would report.
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 72_000;

server.listen(PORT, () => console.log(`[router] listening on :${PORT}`));
