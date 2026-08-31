/**
 * Where an account came from — the user, or the user's agent.
 *
 * Bay's CLI is run by coding agents. Two very different people arrive through
 * the same signup: one told their agent "deploy this to baycloud", the other
 * told it "find me a cloud and ship this" and the agent picked us. Both show up
 * as one row in `users` and one line on a chart, and the work that grows each of
 * them has nothing in common.
 *
 * The first sign-in on a machine therefore carries `--via "<the user's request,
 * verbatim>"`, and this module turns that quote into a channel. The quote is the
 * record; the label is derived from it. That ordering is the whole design: an
 * agent asked to CLASSIFY itself would answer with whatever moves it forward,
 * while an agent asked to COPY a string it already has in front of it has
 * nothing to get wrong.
 *
 * NOTHING IN HERE MAY FAIL A SIGN-IN. This runs inside minting a CLI token,
 * which is the last step of `bay ship` finding itself signed out. An analytics
 * column that turns "you are now logged in" into a 500 is a much worse thing
 * than an analytics column that is empty.
 */

import { getPool } from "./db";

const DB = "supersonic_platform";

export type AcquisitionKind = "named" | "chosen" | "unknown";

/** One line, capped. The CLI caps too; this is the server not trusting it. */
export const MAX_VIA = 200;

/**
 * Do they say our name?
 *
 * Every name this product has answered to, because "supersonic" is still what
 * older docs, older agent prompts and the `supersonic` binary alias say, and
 * somebody who asked for it by that name came looking for us just as much.
 *
 * Word boundaries, so "abaya" is not a match. "Bay" on its own is still a real
 * English word — "deploy this to the bay area office" would classify as `named`
 * — and that is the direction to be wrong in: it undercounts `chosen`, which is
 * the number we want to be able to trust when it goes up.
 */
const NAMES = /\b(bay|baycloud|thebay|thebaycloud|supersonic)\b/i;

/** The literal an agent passes when it has nothing to quote. */
const NO_ANSWER = /^(unknown|unspecified|n\/a|none)$/i;

export function normalizeVia(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VIA);
}

export function classify(via: string): AcquisitionKind {
  const v = normalizeVia(via);
  if (!v || NO_ANSWER.test(v)) return "unknown";
  return NAMES.test(v) ? "named" : "chosen";
}

/**
 * The column may not be there yet, and that must not matter.
 *
 * Nothing in this repository applies db/*.sql on deploy — migrations are run by
 * hand against production. So the control plane can be serving 038 for hours or
 * days before the column exists, and every sign-in in that window would hit an
 * `UndefinedColumn` inside the token mint. Adding the column here, once per
 * process, is the same trick cli-tokens.ts uses for its own table, and it makes
 * the deploy order stop mattering.
 */
let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = getPool(DB)
      .query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_via text;
         ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_kind text;
         ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_at timestamptz`
      )
      .then(() => undefined)
      .catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

/**
 * Record the channel, once, for the life of the account.
 *
 * FIRST TOUCH is enforced by the WHERE clause and not by a read-then-write: two
 * machines signing in at the same second are one UPDATE each, and the second one
 * matches no rows. Signing in again from a laptop six months later cannot
 * rewrite how you originally arrived, which is the only property that makes this
 * column worth reading.
 *
 * Returns whether this call is the one that wrote, so a caller can tell the
 * human "this is what your agent said" rather than showing them a value that was
 * discarded.
 */
export async function recordFirstTouch(userId: string, via: unknown): Promise<boolean> {
  const v = normalizeVia(via);
  if (!userId || !v) return false;
  try {
    await ensure();
    const r = await getPool(DB).query(
      `UPDATE users
          SET acquisition_via = $2, acquisition_kind = $3, acquisition_at = now()
        WHERE id = $1 AND acquisition_via IS NULL`,
      [userId, v, classify(v)]
    );
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.error("[acquisition] could not record first touch:", e);
    return false;
  }
}
