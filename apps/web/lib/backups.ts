import { dbNameForSlug } from "./db";

/**
 * Per-app database backup and restore.
 *
 * WHY THIS EXISTS ALONGSIDE THE INSTANCE'S OWN BACKUPS
 *
 * The shared instance now takes automated backups — it did not until today, which
 * meant every customer database on it had no backup of any kind and a dropped
 * table was simply gone. That is the important half and it is one setting.
 *
 * It is not sufficient, because a Cloud SQL backup restores the INSTANCE. Every
 * app on the shared instance shares one, so restoring app A to yesterday would
 * roll back apps B through Z with it. The instance backup protects against losing
 * the machine; it cannot protect one tenant from its own mistake, which is the
 * failure people actually have.
 *
 * So a logical dump per app, which can be restored into one database and touches
 * nothing else.
 *
 * WHERE THEY GO, AND WHY NOT THE OBVIOUS PLACE
 *
 * A dedicated private bucket, NOT `supersonic-static-assets`. That bucket is what
 * the shared static server publishes from — putting SQL dumps containing every
 * customer's data in it would be one routing mistake away from serving them.
 */

const PROJECT = "supersonic-deploy-prod";
const INSTANCE = "supersonic-shared-pg";

/** Private, lifecycle-expired at 30 days, writable by the Cloud SQL service agent. */
export const BACKUP_BUCKET = "supersonic-db-backups";

/**
 * `backups/<slug>/<iso>.sql.gz` — sorted lexicographically IS sorted by time.
 *
 * Colons are stripped because they are legal in a GCS object name and awkward in
 * every shell that will ever handle one.
 */
export function backupObject(slug: string, at: Date): string {
  return `backups/${slug}/${at.toISOString().replace(/[:.]/g, "-")}.sql.gz`;
}

/** The slug an object belongs to, or null when the name is not one of ours. */
export function slugOfBackup(object: string): string | null {
  return object.match(/^backups\/([a-z0-9-]+)\//)?.[1] ?? null;
}

/**
 * `gcloud sql export` argv for one app's database.
 *
 * `--offload` deliberately NOT set: it runs the export on a temporary instance so
 * the primary is undisturbed, and it costs an instance spin-up per app per run.
 * On a shared instance with one small database per app, the export is seconds and
 * the contention is not worth the money. Revisit if any single app's dump grows.
 */
export function exportArgs(slug: string, object: string): string[] {
  return [
    "sql", "export", "sql", INSTANCE, `gs://${BACKUP_BUCKET}/${object}`,
    "--database", dbNameForSlug(slug),
    "--project", PROJECT, "--quiet",
  ];
}

/**
 * `gcloud sql import` argv, restoring one app's database from one object.
 *
 * DESTRUCTIVE, and the caller has to know it: a logical restore replays a dump
 * over whatever is there now. Postgres dumps from `sql export` carry no `DROP
 * DATABASE`, so this is a merge rather than a replacement — rows the dump does
 * not mention survive, and a primary-key collision fails the import rather than
 * overwriting. That is the safer of the two wrong answers, and it is why the
 * caller must say the app name twice before this runs.
 */
export function importArgs(slug: string, object: string): string[] {
  return [
    "sql", "import", "sql", INSTANCE, `gs://${BACKUP_BUCKET}/${object}`,
    "--database", dbNameForSlug(slug),
    "--project", PROJECT, "--quiet",
  ];
}

/**
 * Did an import actually restore the data, whatever its exit code said?
 *
 * MEASURED, not assumed. A round-trip against a real app database — export, then
 * import into a scratch one — came back as `exit status 3` with
 * `ERROR: permission denied to change default privileges`, and the same output
 * contained `CREATE TABLE` and `COPY 9`. The data was there. The failing
 * statement is `ALTER DEFAULT PRIVILEGES`, which the importing user cannot run on
 * behalf of another role and which governs privileges on objects created LATER —
 * it has nothing to do with the rows.
 *
 * So the exit code is not the verdict, and a caller that trusted it would tell
 * somebody their restore failed while their data sat there restored. Which is the
 * more expensive direction to be wrong in: they would go looking for another
 * backup, or give up.
 *
 * Anything else non-zero is a real failure and is reported as one.
 */
export function importSucceeded(exitCode: number, output: string): boolean {
  if (exitCode === 0) return true;
  const restoredSomething = /\b(CREATE TABLE|COPY \d+|INSERT \d+)\b/.test(output);
  const onlyPrivilegeErrors = (output.match(/^ERROR:.*$/gim) ?? [])
    .every((line) => /default privileges|must be owner|permission denied to (?:set|change)/i.test(line));
  return restoredSomething && onlyPrivilegeErrors;
}

/** Every backup this app has, newest first. Objects only — the caller lists them. */
export function sortNewestFirst(objects: string[]): string[] {
  return [...objects].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/**
 * Which of an app's backups to delete, keeping the newest `keep`.
 *
 * The bucket has a 30-day lifecycle rule, which bounds cost but not count — an
 * app deployed hourly would hold 700 dumps inside that window. This bounds the
 * count; the lifecycle rule bounds the age. Neither alone is enough.
 */
export function expired(objects: string[], keep = 14): string[] {
  return sortNewestFirst(objects).slice(keep);
}
