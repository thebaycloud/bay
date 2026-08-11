/**
 * Who may read which secret, decided by placement rather than by identity.
 *
 * ## What this replaces
 *
 * The node's service account holds `secretmanager.secretAccessor` on the whole
 * project, unconditioned. One escape from one sandbox reads every tenant's
 * database password. The narrow, per-deploy binding existed and was widened
 * deliberately on 5 Aug — a per-deploy binding only covers apps deployed since
 * it was introduced, so the old ones broke. What has stood between that grant
 * and disaster since is the nftables uid rule in `provision.sh`, which keeps the
 * metadata credentials API away from tenants and is therefore load-bearing for
 * the whole fleet's secrets on its own.
 *
 * ## The question the broker asks
 *
 * The node presents itself and the app it is starting. Is that app placed on
 * that node right now, with a live lease? Three things follow:
 *
 *   - the blast radius collapses from "the project" to "the apps currently
 *     placed on this node", checked against our own table rather than by an IAM
 *     condition with propagation delay;
 *   - the lease from §5 becomes an authorisation primitive;
 *   - the dependency becomes a Supersonic service rather than one cloud's
 *     metadata server.
 *
 * ## Why a live lease, when §5 says expiry is not a stop order
 *
 * These do not conflict, and the difference is what is being authorised. In §5
 * expiry authorises the CONTROL PLANE to re-place; the node is not told to stop,
 * and a process already running keeps the environment it was started with. What
 * an expired lease refuses here is a fresh START — which is exactly right, since
 * a start under an expired lease is the second copy the lease exists to prevent.
 */

import { getPool } from "./db";
import { accessToken } from "./gcp-rest";

const DB = "supersonic_platform";
const PROJECT = "supersonic-deploy-prod";

export interface PlacementRow {
  slug: string;
  node: string;
  /** ms since epoch. Compared against `now` rather than trusted as "current". */
  leaseUntil: number;
}

export interface SecretClaim {
  /** Who is asking. Established by the caller's token, never taken from the body alone. */
  node: string;
  /** What it says it is starting. */
  slug: string;
}

export interface Verdict {
  ok: boolean;
  /**
   * Present only on refusal, and phrased for a node operator rather than a
   * tenant. `resolveSecret` in the agent already keeps "not found" and
   * "permission denied" distinct because collapsing them "costs an hour every
   * time"; the same applies here, where the two refusals mean a stale spec and
   * a lost lease respectively.
   */
  reason?: string;
}

/**
 * Does this secret id belong to this app?
 *
 * A SECOND CHECK, and not a redundant one. `maySeeSecrets` answers "may this
 * node act for `shop`" and says nothing about which ids the request then lists.
 * Without this, a node legitimately holding `shop` asks for
 * `app-blog-DATABASE_URL` and the broker — having already said yes — fetches it
 * with the CONTROL PLANE's credentials, which are broader than the node's have
 * ever been. That is not a smaller blast radius than today's; it is a larger one
 * with an audit trail.
 *
 * Matched against `secretName` (app-secrets.ts:60) exactly: `app-${slug}-${key}`
 * with a non-empty key. A bare `startsWith("app-" + slug)` would let `shop`
 * reach `app-shopfront-*`, and slugs are user-chosen — so a tenant can register
 * a slug that is a prefix of another tenant's on purpose.
 */
export function ownedBy(slug: string, secretId: string): boolean {
  const prefix = `app-${slug}-`;
  return secretId.startsWith(prefix) && secretId.length > prefix.length;
}

export function maySeeSecrets(rows: PlacementRow[], claim: SecretClaim, now: number): Verdict {
  // Both halves of the pair, deliberately. A rule matching only on slug would
  // let one node's placement authorise another's read; a rule matching only on
  // node would make holding any app authority over every app.
  const mine = rows.filter((r) => r.slug === claim.slug && r.node === claim.node);
  if (mine.length === 0) {
    return { ok: false, reason: `${claim.slug} is not placed on ${claim.node}` };
  }
  // The most generous lease wins when an app has more than one row here, which
  // it should not but has: the duplicate `(slug, node)` rows that 024 had to
  // renumber were invisible to every reader that took the first row it found.
  const until = Math.max(...mine.map((r) => r.leaseUntil));
  if (until <= now) {
    return { ok: false, reason: `the lease on ${claim.slug} at ${claim.node} expired ${Math.round((now - until) / 1000)}s ago` };
  }
  return { ok: true };
}

/**
 * Every placement of this app on this node, with its lease.
 *
 * Scoped in SQL rather than filtered in TypeScript so a fleet with many nodes
 * does not read every placement to answer one node's question — and so the pair
 * (slug, node) is the only thing this query can ever return, which is one fewer
 * place for the "matched on slug alone" mistake to live.
 */
export async function placementsOf(slug: string, node: string): Promise<PlacementRow[]> {
  const { rows } = await getPool(DB).query(
    `SELECT slug, node, COALESCE(EXTRACT(EPOCH FROM lease_until) * 1000, 0) AS lease_ms
       FROM fleet_placements WHERE slug = $1 AND node = $2`,
    [slug, node],
  );
  return rows.map((r: { slug: string; node: string; lease_ms: string }) => ({
    slug: r.slug,
    node: r.node,
    leaseUntil: Number(r.lease_ms),
  }));
}

/**
 * One secret's current value, read with the CONTROL PLANE's credentials.
 *
 * This is the privilege the broker concentrates, and the reason both checks
 * above must pass before it is reached: the control plane can read every secret
 * in the project, which is precisely what the node is being relieved of.
 *
 * The API's own message is preserved on failure, for the reason `resolveSecret`
 * in the agent already records: "not found" and "permission denied" are a bad
 * spec and a missing binding respectively, and collapsing them costs an hour
 * every time.
 */
export async function readSecret(id: string): Promise<string> {
  const tok = await accessToken();
  if (!tok) throw new Error("the control plane has no credentials to read secrets with");
  const r = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${encodeURIComponent(id)}/versions/latest:access`,
    { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(15_000) },
  );
  const raw = await r.text();
  if (!r.ok) throw new Error(`secret ${id}: ${r.status} ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw) as { payload?: { data?: string } };
  const data = j.payload?.data;
  if (!data) throw new Error(`secret ${id}: no payload`);
  return Buffer.from(data, "base64").toString("utf8");
}
