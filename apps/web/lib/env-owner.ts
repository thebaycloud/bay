import { databaseEnvNames } from "./lanes";

/**
 * Whose variable this is: the app's, or ours.
 *
 * The Keys screen listed twenty-five names in one flat column with a green `set`
 * chip beside each, and every one of them looked equally like something you had
 * configured. Twenty of them were ours — `DATABASE_URL`, the seventeen database
 * names, `PORT`, `BAY_URL` — and offering an owner a delete button next to
 * `PGHOST` is offering to break their app for no gain, since the next deploy
 * writes it straight back.
 *
 * So the same question `platformOwned` asks at parse time gets asked here, from
 * the same lists — this module now OWNS them and `app-config.ts` imports them,
 * rather than the two agreeing by coincidence. That is the whole point: the lists
 * drifted apart once already, six protected names against seventeen written, and
 * every name in the gap was a user value the platform silently overwrote.
 *
 * Client-safe on purpose. `app-config.ts` reads the filesystem, so the panel
 * cannot import the rule from there, and a second copy of the rule in the panel
 * is the drift again with a new face.
 */

/**
 * Ours no matter what the app declares.
 *
 * `PORT` is assigned by the runtime and injected into the container. `BAY_*` and
 * `SUPERSONIC_*` are this platform's own namespace — `universalFacts` emits all
 * four facts under BOTH prefixes, and will keep doing so until the people running
 * apps have been told, because somebody's settings.py reads
 * `os.environ["SUPERSONIC_HOSTNAME"]` in a repository we cannot survey.
 *
 * `BAY_` was MISSING here until this module existed. The rename shipped, the
 * platform started writing `BAY_URL` and friends, and the protected list still
 * only knew `SUPERSONIC_`. So an app could declare `BAY_URL` in its config, parse
 * clean, and have it silently overwritten on deploy — the exact bug the comment
 * on this list was written to prevent, reintroduced by a rebrand.
 */
export const ALWAYS_OWNED_PREFIXES = [/^BAY_/, /^SUPERSONIC_/];
export const ALWAYS_OWNED_EXACT = new Set(["PORT"]);

/**
 * Ours only while we are the one provisioning the database.
 *
 * Derived from `databaseEnv()` rather than typed out again. The prefixes are
 * deliberately broad: `PGSSLMODE` is not written today, but it configures the
 * same connection, and somebody setting it while the platform supplies the
 * endpoint is describing a connection they do not control.
 */
export const DATABASE_OWNED_PREFIXES = [/^POSTGRES_/, /^PG/, /^DB_/];
export const DATABASE_OWNED_EXACT = new Set(databaseEnvNames());

export type EnvOwner =
  /** The app's own. Editable, removable. */
  | "app"
  /** Ours, from the database we provisioned for this app. */
  | "database"
  /** Ours, always — the runtime's port and this platform's namespace. */
  | "platform";

/**
 * Who owns a variable.
 *
 * `managedDatabase` is the fact the answer turns on, and it is a FACT rather
 * than a guess: the panel knows whether this app has a database on our instance
 * because it just read one. An app on Supabase owns its own `DATABASE_URL`, and
 * treating those seventeen names as ours unconditionally would be a refusal aimed
 * at the wrong app — which is precisely the mistake `platformOwned` was corrected
 * for.
 */
export function envOwner(name: string, opts: { managedDatabase: boolean }): EnvOwner {
  if (ALWAYS_OWNED_EXACT.has(name) || ALWAYS_OWNED_PREFIXES.some((re) => re.test(name))) {
    return "platform";
  }
  if (
    opts.managedDatabase &&
    (DATABASE_OWNED_EXACT.has(name) || DATABASE_OWNED_PREFIXES.some((re) => re.test(name)))
  ) {
    return "database";
  }
  return "app";
}

/** A name the environment can actually hold. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why this name cannot be set, or null when it can be.
 *
 * Said before the request rather than after it, and in the words of the thing
 * that would go wrong: "Bay sets this one" is the answer to "why is my value
 * being ignored", which is the question somebody would otherwise ask a build log.
 */
export function nameRefusal(name: string, opts: { managedDatabase: boolean }): string | null {
  const n = name.trim();
  if (n === "") return "a name is required";
  if (!ENV_NAME.test(n)) return "letters, digits and underscores, not starting with a digit";
  const owner = envOwner(n, opts);
  if (owner === "platform") return "Bay sets this one — your value would be overwritten on the next ship";
  if (owner === "database") return "Bay sets this from the database it provisioned for this app";
  return null;
}
