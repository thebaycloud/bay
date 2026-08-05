/**
 * Deciding which of an app's variables travel as secrets and which as plain
 * environment — and making sure no name does both.
 *
 * Cloud Run rejects a variable set two ways in one revision:
 *
 *   ERROR: (gcloud.run.deploy) Cannot update environment variable [POSTGRES_DB]
 *   to the given type because it has already been set with a different type.
 *
 * That is a hard deploy failure, and it was reachable by an entirely ordinary
 * repository: the FastAPI template ships a `.env` naming POSTGRES_DB, which the
 * CLI uploads and the platform stores in Secret Manager, while the platform ALSO
 * publishes its own POSTGRES_DB as a plain variable pointing at the database it
 * just provisioned. Two flags, one name, dead deploy. It surfaced on that
 * template's `/api` service, but nothing about it is specific to a second
 * service — a single Python app with the same `.env` fails the same way.
 *
 * Precedence is not a toss-up. A repository's `.env` describes the database on
 * its author's laptop; the deployed app has to talk to the one that exists.
 * Keeping the author's value would leave a live app pointed at a database that
 * is not there, so the platform's connection settings win — and the value that
 * loses is dropped rather than moved somewhere it can collide.
 */

export interface MergedEnv {
  /** Stored in Secret Manager and injected by reference. */
  secretEnv: Record<string, string>;
  /** Plain `KEY=value` strings for --update-env-vars. */
  plainEnv: string[];
}

/** Credentials, wherever they come from. Never plain variables in a revision spec. */
const CREDENTIAL = /PASSWORD$|^DATABASE_URL$/;

/**
 * Combine what the app declared with what the platform provisioned.
 *
 * `appSecrets` is everything the user's `.env` carried — all of it sensitive by
 * default, because we cannot tell which half is. `databaseEnv` is the
 * platform's own `KEY=value` list for the database it created.
 */
export function mergeDatabaseEnv(appSecrets: Record<string, string>, databaseEnv: string[]): MergedEnv {
  const secretEnv: Record<string, string> = { ...appSecrets };
  const plainEnv: string[] = [];

  for (const entry of databaseEnv) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (CREDENTIAL.test(key)) {
      // Overwrites whatever the app shipped: same reason as below, plus a
      // credential belongs in Secret Manager rather than three more times in a
      // revision spec.
      secretEnv[key] = value;
      continue;
    }
    // The platform's value wins, and the app's copy of that name stops being a
    // secret — otherwise the same name arrives by both routes.
    delete secretEnv[key];
    plainEnv.push(entry);
  }

  return { secretEnv, plainEnv };
}

/**
 * The literals a service declared in `supersonic.json`, as plain `KEY=value`.
 *
 * Schema v2 introduced `env` as an object of committed, non-secret, deploy-shaping
 * values — NODE_ENV, LOG_LEVEL, SKIP_DB_MIGRATION — and for several deploys it
 * was parsed, validated, listed by `supersonic check` under "env", declared
 * consumable by every lane in LANE_CONSUMES, and then read by nothing. The
 * revision came up without a single one of them. That is the exact
 * ignored-but-present asymmetry the schema was written to end, pointed at the
 * field the schema added.
 *
 * A name the deploy is already carrying as a secret is dropped rather than set,
 * because Cloud Run refuses a variable that arrives as both types in one revision
 * — the same rule mergeDatabaseEnv exists for. The `.env` wins that tie for the
 * same reason the platform's database settings do: it describes the environment
 * this deploy is actually going into, while the committed file describes every
 * environment at once. The caller is expected to say which names it dropped.
 */
export function configEnv(
  declared: Record<string, string> | undefined,
  secretNames: Iterable<string>,
): { env: string[]; shadowed: string[] } {
  const isSecret = new Set(secretNames);
  const env: string[] = [];
  const shadowed: string[] = [];
  for (const [key, value] of Object.entries(declared ?? {})) {
    if (isSecret.has(key)) shadowed.push(key);
    else env.push(`${key}=${value}`);
  }
  return { env, shadowed };
}

/**
 * Restate a service's database connection at the address IT runs at.
 *
 * A sibling inherits the primary's environment, and that environment names the
 * database at the primary's address. When the two run in different places the
 * inherited value is not merely stale, it is unroutable: on the fleet the
 * primary gets 10.200.0.1, the host-side proxy on the node, and a sibling on
 * Cloud Run has no path to it at all. The app comes up looking healthy and
 * every request that touches the database fails.
 *
 * Pure, and separate from `deploySibling`, because that function is four
 * hundred lines with a build and two gcloud calls in it — the address decision
 * is the part worth pinning and the only part that can be checked without a
 * cloud. Returns the same shape `mergeDatabaseEnv` does, plus the surviving
 * inherited variables, so the caller has one thing to hand to the deploy.
 *
 * Every name `databaseEnv` writes is dropped before the new values are added,
 * rather than the new ones being appended and left to win by ordering: `PGHOST`
 * appearing twice in one `--update-env-vars` is a coin toss, and the losing side
 * of that coin is an app that cannot reach its database.
 */
export function restateDatabaseAt(
  inherited: string[],
  freshDatabaseEnv: string[],
  databaseNames: string[],
): MergedEnv & { inherited: string[] } {
  const owned = new Set(databaseNames);
  const kept = inherited.filter((entry) => {
    const eq = entry.indexOf("=");
    return eq <= 0 || !owned.has(entry.slice(0, eq));
  });
  // Merged against nothing: these are the platform's own values for a database
  // it provisioned, and the app's copies of these names were already resolved
  // once, for the primary.
  const { secretEnv, plainEnv } = mergeDatabaseEnv({}, freshDatabaseEnv);
  return { inherited: kept, secretEnv, plainEnv };
}
