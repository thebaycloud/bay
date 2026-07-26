import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../lib/db";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Every migration is idempotent, so applying all of them every time is safe
  // and removes the need for a tracking table.
  const files = readdirSync(here)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const pool = getPool("supersonic_platform");
  for (const file of files) {
    await pool.query(readFileSync(join(here, file), "utf8"));
    console.log(`migration ${file} applied`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
