/**
 * The box watcher — what makes a preview appear without anybody asking for one.
 *
 * `bay preview 3000` was one step too many. A dev server that has started
 * already knows everything the address needs: the port it is listening on, and
 * the directory it was started in — which names the branch, which names the
 * address. So nothing has to be typed; this notices and publishes.
 *
 * The chain is: listening socket → pid → /proc/pid/cwd → git branch → slug.
 * Deliberately NOT herdr's pane tree, though it could answer the same question:
 * this way a dev server started over ssh, from a script, or by an agent that
 * never went through a pane is published on the same terms as one started by
 * hand.
 *
 * Publishing is two writes, the same two `bay preview` makes: the router's table
 * and one row in `apps`. Both are made ONLY when the mapping actually changes —
 * this loop runs every two seconds, and a database write on every tick would be
 * a write every two seconds forever.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROUTES = "/srv/box/routes.json";
const ENV_FILE = "/srv/box/env";
const ROOT_DOMAIN = "thebay.cloud";
const EVERY_MS = 2000;

/**
 * Ports a person could plausibly mean, and the ones they never do.
 *
 * A range rather than a list because dev servers pick their own port when the
 * one they wanted is taken — 3000 becomes 3001 becomes 3002 — and a fixed list
 * would publish the first agent's server and silently not the second's.
 *
 * 8080 is this box's own router. Publishing it would point the router at
 * itself, and the loop that produces is only visible as a hang.
 */
const MIN_PORT = 3000, MAX_PORT = 9999;
const NEVER = new Set([8080, 5433]);

function boxEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* reported by the caller, which knows what it needed */ }
  return out;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
}

/** Every LISTEN socket in the dev range, with the pid holding it. */
function listeners() {
  let raw = "";
  try { raw = sh("ss", ["-ltnpH"]); } catch { return []; }
  const found = [];
  for (const line of raw.split("\n")) {
    const addr = line.match(/LISTEN\s+\d+\s+\d+\s+(\S+)/);
    const pid = line.match(/pid=(\d+)/);
    if (!addr || !pid) continue;
    const port = Number(addr[1].split(":").pop());
    if (!port || port < MIN_PORT || port > MAX_PORT || NEVER.has(port)) continue;
    found.push({ port, pid: Number(pid[1]) });
  }
  return found;
}

/**
 * What to call the thing on this port.
 *
 * The branch, because that is what one-worktree-per-task makes distinct — three
 * agents on three branches get three addresses without naming anything. The
 * directory is the fallback for a checkout that is not on a branch, which is
 * what a detached HEAD looks like.
 */
function nameFor(pid) {
  let cwd;
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
  // A dev server belongs to a person's checkout. Anything outside /home is a
  // system daemon that happened to pick a port in the range, and publishing it
  // would put a service nobody asked to share on a public hostname.
  if (!cwd.startsWith("/home/")) return null;
  // The opt-out, for a port that should stay on the box.
  if (fs.existsSync(path.join(cwd, ".bay-no-preview"))) return null;
  let name = "";
  try {
    // `safe.directory` on the call, not in a config file. This runs as root
    // over checkouts owned by somebody else, which is exactly what git refuses
    // by default — and it refuses by printing advice to stderr and exiting
    // non-zero, so without this every branch silently became the directory
    // name and every worktree of one repo collided on one address.
    name = sh("git", ["-c", "safe.directory=*", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  } catch { /* not a repo; the directory name is the answer */ }
  if (!name || name === "HEAD") name = path.basename(cwd);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || null;
}

function readRoutes() {
  try { return JSON.parse(fs.readFileSync(ROUTES, "utf8")); } catch { return {}; }
}

function writeRoutes(next) {
  const tmp = ROUTES + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.chmodSync(tmp, 0o644);
  // Renamed rather than written in place: the router watches this file, and a
  // partial write is a routing table with no routes in it.
  fs.renameSync(tmp, ROUTES);
}

let pgPassword = null;
function password() {
  if (pgPassword) return pgPassword;
  pgPassword = sh("gcloud", ["secrets", "versions", "access", "latest",
    "--secret=supersonic-pg-password", "--project=supersonic-deploy-prod"]);
  return pgPassword;
}

function publish(slug, env) {
  const ip = sh("curl", ["-sf", "-H", "Metadata-Flavor: Google",
    "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip"]);
  const sql = `
    INSERT INTO apps (slug, workspace_id, owner_id, run_url, visibility, status, runtime, has_web)
    VALUES ('${slug}', '${env.BAY_WORKSPACE_ID}', '${env.BAY_OWNER_ID}',
            'http://${ip}:8080', 'private', 'live', 'cloudrun', true)
    ON CONFLICT (slug) DO UPDATE
       SET run_url = EXCLUDED.run_url, status = 'live', has_web = true;`;
  execFileSync("psql", ["-h", "127.0.0.1", "-p", "5433", "-U", "postgres",
    "-d", "supersonic_platform", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql],
    { env: { ...process.env, PGPASSWORD: password() }, stdio: ["ignore", "ignore", "pipe"] });
}

const env = boxEnv();
if (!env.BAY_OWNER_ID || !env.BAY_WORKSPACE_ID) {
  console.error(`[watch] ${ENV_FILE} has no owner — nothing could be published. Exiting.`);
  process.exit(1);
}

/** Slugs this process has already written a row for, so it writes each once. */
const published = new Set();

function tick() {
  const live = listeners();
  const wanted = {};
  for (const { port, pid } of live) {
    const slug = nameFor(pid);
    if (!slug) continue;
    // Lowest port wins the branch's own name. A project that runs a web server
    // and an API gets the web server at the address, which is the one somebody
    // opening the link meant; the other is still reachable, under its port.
    if (wanted[slug] === undefined || port < wanted[slug]) wanted[slug] = port;
  }

  const current = readRoutes();
  const changed = JSON.stringify(current) !== JSON.stringify(wanted);
  if (changed) {
    writeRoutes(wanted);
    for (const [slug, port] of Object.entries(wanted)) {
      if (current[slug] === port) continue;
      console.log(`[watch] https://${slug}.${ROOT_DOMAIN}  →  127.0.0.1:${port}`);
    }
    for (const slug of Object.keys(current)) {
      // The route goes when the server does. The app row stays: it costs
      // nothing, keeps the address stable across restarts of a dev server, and
      // the router already says "registered, but nothing is listening" — which
      // is the true thing to say about a dev server somebody stopped.
      if (wanted[slug] === undefined) console.log(`[watch] gone: ${slug}`);
    }
  }

  for (const slug of Object.keys(wanted)) {
    if (published.has(slug)) continue;
    try {
      publish(slug, env);
      published.add(slug);
      console.log(`[watch] published ${slug}`);
    } catch (e) {
      // Worth one line, not a crash: the control plane being unreachable must
      // not stop the routing table from tracking what is running on this box.
      console.error(`[watch] could not publish ${slug}: ${String(e.message).split("\n")[0]}`);
    }
  }
}

console.log("[watch] watching for dev servers");
tick();
setInterval(tick, EVERY_MS);
