/**
 * Give every app that already exists a site to be counted in.
 *
 * Provisioning happens on `createAppRecord`, which only ever runs for a deploy
 * — so without this, analytics would arrive for apps deployed after it shipped
 * and never for the ones already running, which is precisely backwards from
 * whose owner is waiting for it.
 *
 * Safe to run repeatedly: `ensureWebsite` looks up by domain before it creates,
 * and the UPDATE only writes rows that are still null.
 *
 *   npm --workspace @supersonic/web exec -- node --import tsx db/backfill-umami.ts
 */
import { getPool } from "../lib/db";
import { ensureWebsite, umamiConfigured } from "../lib/umami";

async function main() {
  if (!umamiConfigured()) {
    console.error("UMAMI_URL / UMAMI_PASSWORD are not set — nothing to do.");
    process.exit(1);
  }
  const pool = getPool("supersonic_platform");
  const { rows } = await pool.query<{ slug: string }>(
    `SELECT slug FROM apps WHERE umami_website_id IS NULL ORDER BY created_at`
  );
  console.log(`${rows.length} apps without a site`);

  let made = 0;
  for (const { slug } of rows) {
    // One at a time on purpose. This runs once, against an instance sized for
    // tracker traffic rather than for a burst of admin writes, and thirty-two
    // sequential calls take a few seconds.
    const id = await ensureWebsite(slug);
    if (!id) {
      console.error(`  ${slug}: no site (umami did not answer)`);
      continue;
    }
    await pool.query(
      `UPDATE apps SET umami_website_id = $2 WHERE slug = $1 AND umami_website_id IS NULL`,
      [slug, id]
    );
    made++;
    console.log(`  ${slug}: ${id}`);
  }
  console.log(`${made}/${rows.length} apps now have analytics`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
