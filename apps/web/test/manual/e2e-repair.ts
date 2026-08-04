/**
 * Not part of the suite. Runs the real repair agent against a real broken app,
 * with a redeploy that genuinely starts the app and checks it binds $PORT — so
 * "it worked" means the app works, not that the agent said so.
 *
 *   OPENAI_API_KEY=… DEPLOY_AGENT=codex \
 *     node --import tsx test/manual/e2e-repair.ts ../../examples/broken
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentRepair, agentName } from "../../lib/agents";

const src = process.argv[2];
if (!src) { console.error("usage: e2e-repair.ts <repo-dir>"); process.exit(2); }

// A copy, so a real agent editing real files does not edit the repo.
const dir = mkdtempSync(join(tmpdir(), "ss-e2e-repo-"));
cpSync(resolve(src), dir, { recursive: true });
console.log(`backend: ${agentName()}`);
console.log(`repo copy: ${dir}`);

/** Start the app with a PORT assigned and see whether it binds it. */
function tryRun(port: number): Promise<{ ok: boolean; url?: string; error?: string }> {
  return new Promise((done) => {
    const p = spawn("node", ["server.js"], {
      cwd: dir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const finish = (r: { ok: boolean; url?: string; error?: string }) => {
      try { p.kill("SIGKILL"); } catch { /* gone */ }
      done(r);
    };
    const timer = setTimeout(async () => {
      // Bound to the port we asked for?
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        finish(res.ok
          ? { ok: true, url: `http://127.0.0.1:${port}` }
          : { ok: false, error: `responded ${res.status}` });
      } catch {
        finish({
          ok: false,
          error: `container failed to start and listen on PORT=${port}. Logs:\n${out.slice(0, 400)}`,
        });
      }
    }, 1500);
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { out += d.toString(); });
    p.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
  });
}

let attempt = 0;

async function main() {
const first = await tryRun(8080);
console.log(`initial deploy: ${first.ok ? "ok" : "FAILED"} — ${first.error?.split("\n")[0] ?? first.url}`);

const t0 = Date.now();
const r = await agentRepair({
  dir,
  slug: "e2e",
  initialError: first.error ?? "unknown",
  // Each redeploy uses a fresh port, so a stale listener cannot make a broken
  // app look fixed.
  redeploy: () => tryRun(8100 + attempt++),
  log: (l) => console.log("   " + l),
  timeoutMs: 300000,
});

console.log(`\n=== RESULT (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
console.log(JSON.stringify({ ok: r.ok, url: r.url, changes: r.changes, steps: r.steps, redeploys: r.redeploys }, null, 2));
console.log(`summary: ${r.summary}`);
console.log("\n=== server.js now ===");
console.log(readFileSync(join(dir, "server.js"), "utf8").trim().split("\n").slice(-3).join("\n"));
}

main().catch((e) => { console.error("e2e failed:", e); process.exit(1); });
