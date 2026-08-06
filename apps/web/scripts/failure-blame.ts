/**
 * Who is actually failing, and whose fault the platform says it is.
 *
 * `classify` (lib/deploy-errors.ts) decides at deploy time whether a failure is
 * the platform's or the app's, and that verdict decides everything downstream:
 * platform failures roll back and stop, app failures go to the repair agent.
 * The verdict is never stored — only the error text is — so the only way to
 * ask "what have we been blaming users for" is to re-run the same pure
 * function over the rows after the fact, which is what this does.
 *
 * Read-only. Run: npm run blame
 */
import { getPool } from "@/lib/db";
import { classify } from "@/lib/deploy-errors";

const DB = "supersonic_platform";

/** The first line of an error, which is the part `classify` treats as the verdict. */
function head(e: string | null): string {
  return (e ?? "").split("\n")[0].trim().slice(0, 100) || "(empty)";
}

async function main() {
  const pool = getPool(DB);

  const { rows } = await pool.query<{
    slug: string; owner_id: string | null; status: string; error: string | null; updated_at: Date;
  }>(`SELECT slug, owner_id, status, error, updated_at FROM deploys ORDER BY updated_at DESC`);

  console.log(`\n### Every deploy row on file: ${rows.length}`);

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  console.table([...byStatus].map(([status, n]) => ({ status, n })));

  const failed = rows.filter((r) => r.status === "failed");
  console.log(`\n### Failed deploys: ${failed.length}`);

  // Whose fault the platform decided it was, recomputed with the real function.
  const blamed = failed.map((r) => ({ ...r, blame: classify(r.error).blame }));
  const platform = blamed.filter((b) => b.blame === "platform");
  const app = blamed.filter((b) => b.blame === "app");
  console.log(`  platform: ${platform.length}   app: ${app.length}` +
    `   (app is classify's DEFAULT verdict — anything unrecognised lands here)`);

  console.log(`\n### Failures with NO error text at all`);
  const silent = failed.filter((r) => !(r.error ?? "").trim());
  console.log(`  ${silent.length} of ${failed.length} — classify calls these platform,` +
    ` "a gap in our reporting, not in your code"`);

  console.log(`\n### Owners (who is doing the failing)`);
  const byOwner = new Map<string, { total: number; failed: number }>();
  for (const r of rows) {
    const k = r.owner_id ?? "(none)";
    const e = byOwner.get(k) ?? { total: 0, failed: 0 };
    e.total++; if (r.status === "failed") e.failed++;
    byOwner.set(k, e);
  }
  console.table([...byOwner]
    .map(([owner, v]) => ({ owner: owner.slice(0, 28), deploys: v.total, failed: v.failed,
      pct: v.total ? Math.round((100 * v.failed) / v.total) : 0 }))
    .sort((a, b) => b.deploys - a.deploys).slice(0, 12));

  console.log(`\n### What the app-blamed failures actually say (these went to the repair agent)`);
  const heads = new Map<string, number>();
  for (const a of app) heads.set(head(a.error), (heads.get(head(a.error)) ?? 0) + 1);
  console.table([...heads].map(([error, n]) => ({ n, error }))
    .sort((a, b) => b.n - a.n).slice(0, 15));

  console.log(`\n### What the platform-blamed failures say`);
  const pheads = new Map<string, number>();
  for (const p of platform) pheads.set(head(p.error), (pheads.get(head(p.error)) ?? 0) + 1);
  console.table([...pheads].map(([error, n]) => ({ n, error }))
    .sort((a, b) => b.n - a.n).slice(0, 12));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
