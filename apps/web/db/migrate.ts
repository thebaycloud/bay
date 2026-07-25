import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../lib/db";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, "001_sharing.sql"), "utf8");
  const pool = getPool("supersonic_platform");
  await pool.query(sql);
  console.log("migration 001_sharing applied");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
