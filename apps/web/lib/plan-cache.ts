import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool } from "./db";
import { hashEntries, type FileEntry } from "./dirhash";
import { readRepoFacts } from "./repo-facts";
import type { DeployPlan } from "./opencode-deploy";

const DB = "supersonic_platform";

/**
 * The plan, remembered against the bytes that produced it.
 *
 * Every cache in this system caches a step — the clone, the layer, the
 * dependency tarball, the prepared bundle. None of them caches a *decision*, so
 * the planner re-derived the same answer from the same bytes on every deploy: 87
 * seconds on 1 Aug to conclude `node index.js` for a project that had not
 * changed since the last time it concluded `node index.js`.
 *
 * Keyed by content rather than by slug, so the second deploy of an unchanged repo
 * is free AND so is the first deploy of a repo somebody forked — the answer
 * depends on the files, not on who is asking.
 *
 * This is a cache, not a source of truth: a miss costs what planning always cost,
 * and every read is wrapped so that a database having a bad day slows a deploy
 * down rather than failing it.
 */

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = getPool(DB).query(
      `CREATE TABLE IF NOT EXISTS plan_cache (
         key   text        PRIMARY KEY,
         plan  jsonb       NOT NULL,
         at    timestamptz NOT NULL DEFAULT now()
       )`,
    ).then(() => undefined).catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

/**
 * The files that can change a plan.
 *
 * Deliberately not the whole tree. Hashing everything would miss the point: an
 * edit to a React component cannot change how the app is installed, built or
 * started, and treating it as though it could means the cache never hits on a
 * repository anyone is actually working on.
 *
 * What is here is what the planner is asked to read — the manifests, the
 * lockfiles, any Dockerfile, and `supersonic.json` — plus the paths they live at,
 * because a `pyproject.toml` moving from the root to `backend/` is a different
 * repository shape even if the bytes are identical.
 */
export function planInputs(dir: string): FileEntry[] {
  const facts = readRepoFacts(dir);
  const paths = new Set<string>([
    ...facts.declarations.map((d) => d.from),
    ...facts.dockerfiles,
    "supersonic.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "Procfile",
  ]);
  const out: FileEntry[] = [];
  for (const path of [...paths].sort()) {
    try {
      out.push({ path, bytes: readFileSync(join(dir, path)) });
    } catch {
      // Absent is information too, but absence is already encoded: a file that is
      // not here contributes no entry, and adding one later changes the hash.
    }
  }
  return out;
}

/** The cache key for a repository, or null when there is nothing to key on. */
export function planKey(dir: string): string | null {
  const inputs = planInputs(dir);
  // A repository with no manifest at all — a folder of HTML — has nothing that
  // identifies it. Hashing the empty set would give every such folder the same
  // key and serve them each other's plans.
  if (!inputs.length) return null;
  return hashEntries(inputs);
}

/** A plan cached for these exact inputs, or null. */
export async function getCachedPlan(key: string): Promise<DeployPlan | null> {
  try {
    await ensure();
    const r = await getPool(DB).query(`SELECT plan FROM plan_cache WHERE key = $1`, [key]);
    return (r.rows[0]?.plan as DeployPlan) ?? null;
  } catch {
    return null;
  }
}

/** Remember a plan. Best-effort: a cache that cannot be written must not fail a deploy. */
export async function putCachedPlan(key: string, plan: DeployPlan): Promise<void> {
  try {
    await ensure();
    await getPool(DB).query(
      `INSERT INTO plan_cache(key, plan) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET plan = EXCLUDED.plan, at = now()`,
      [key, JSON.stringify(plan)],
    );
  } catch { /* the deploy matters more than remembering it */ }
}
