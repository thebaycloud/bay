/**
 * Create a teammate's outreach account and print its extension token.
 *
 *   npx tsx scripts/create-account.ts "Arsen" arsen@supersonic.cv Europe/Berlin
 *
 * The token is shown once and stored only as a hash — losing it means creating
 * a new one, not recovering the old.
 */
import { getPool } from "../src/db";
import { generateToken, hashToken } from "../src/auth";

async function main() {
  const [label, email, timezone] = process.argv.slice(2);
  if (!label || !email) {
    console.error('usage: tsx scripts/create-account.ts "<label>" <email> [timezone]');
    process.exit(1);
  }

  const token = generateToken();
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO accounts (label, email, token_hash, timezone)
     VALUES ($1, $2, $3, COALESCE($4, 'UTC'))
     ON CONFLICT (email) DO UPDATE SET
       label = EXCLUDED.label,
       token_hash = EXCLUDED.token_hash,
       timezone = EXCLUDED.timezone
     RETURNING id`,
    [label, email.toLowerCase(), hashToken(token), timezone ?? null],
  );

  console.log(`account ${rows[0].id} (${email})`);
  console.log(`token:   ${token}`);
  console.log("Paste the token into the extension's Settings tab. It is not stored in plaintext.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
