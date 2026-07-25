/**
 * Import pre-existing Cloud Run services into the `apps` table.
 *
 * Run this BEFORE pointing *.supersonic.cv at the load balancer: once DNS moves,
 * the proxy resolves every request against this table, and an app that is not in
 * it returns 404.
 *
 * This script only inserts rows. It deliberately does NOT change IAM — sealing a
 * live app is a separate, visible decision.
 */
import { execFileSync } from "node:child_process";
import { getPool } from "../lib/db";

const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";

/**
 * Public surfaces that must never become private-by-default.
 * `supersonic-control-plane` is the login page itself — putting it behind the
 * proxy would make signing in impossible, since signing in is what the proxy
 * requires. The landing pages are the public website.
 */
const EXCLUDE = new Set([
  "supersonic-proxy",
  "supersonic-control-plane",
  "landing",
  "supersonic-landing",
]);

interface Svc {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: { url?: string };
}

async function main() {
  const raw = execFileSync(
    "gcloud",
    ["run", "services", "list", "--region", REGION, "--project", PROJECT, "--format=json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const services = JSON.parse(raw) as Svc[];
  const pool = getPool("supersonic_platform");

  for (const s of services) {
    const slug = s.metadata?.name;
    const owner = s.metadata?.labels?.["supersonic-owner"];
    const url = s.status?.url;
    if (!slug || !owner) continue;
    if (EXCLUDE.has(slug)) {
      console.log(`skip ${slug}: public surface`);
      continue;
    }
    const u = await pool.query(`SELECT workspace_id FROM users WHERE id = $1`, [owner]);
    const workspaceId = u.rows[0]?.workspace_id;
    if (!workspaceId) {
      // Workspaces are assigned at sign-in. An owner who has not signed in since
      // the sharing layer landed has none yet, and the row's NOT NULL FK would fail.
      console.log(`skip ${slug}: owner ${owner} has no workspace`);
      continue;
    }
    await pool.query(
      `INSERT INTO apps(slug, workspace_id, owner_id, run_url, visibility, status)
       VALUES($1,$2,$3,$4,'private','live') ON CONFLICT(slug) DO NOTHING`,
      [slug, workspaceId, owner, url ?? null]
    );
    console.log(`imported ${slug}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
