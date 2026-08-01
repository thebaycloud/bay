import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../lib/db";
import { isNoTransaction, splitStatements } from "../lib/sql-statements";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Every migration is idempotent, so applying all of them every time is safe
  // and removes the need for a tracking table.
  const files = readdirSync(here)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const pool = getPool("supersonic_platform");
  for (const file of files) {
    const sql = readFileSync(join(here, file), "utf8");
    // A whole file in one query() is a multi-statement simple query, which
    // Postgres runs as one implicit transaction block — which is what makes a
    // failed migration roll back cleanly, and also what makes CREATE INDEX
    // CONCURRENTLY impossible. A file that asks for it is sent one statement at
    // a time instead, so each runs outside any transaction. Opt-in: every file
    // without the directive behaves exactly as it always has.
    if (isNoTransaction(sql)) {
      const statements = splitStatements(sql);
      for (const [i, statement] of statements.entries()) {
        await pool.query(statement);
        console.log(`migration ${file} [${i + 1}/${statements.length}] applied`);
      }
    } else {
      await pool.query(sql);
      console.log(`migration ${file} applied`);
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
