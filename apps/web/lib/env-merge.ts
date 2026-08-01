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
