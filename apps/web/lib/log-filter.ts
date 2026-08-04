/**
 * Where one app's log lines live, for Cloud Logging.
 *
 * Two places, asked at once. A Cloud Run app writes to `cloud_run_revision`
 * under its service name; an app on a fleet node writes to a file that the ops
 * agent ships under `gce_instance`. An `OR` rather than a branch on
 * `apps.runtime` for two reasons: the callers do not have the runtime and would
 * each have to fetch it, and an app being MIGRATED has lines in both places on
 * the same day — which is precisely when someone is watching.
 *
 * This is one function because three call sites built this string inline and
 * none imported from another. The fourth would have had the Cloud Run arm only.
 *
 * Severity is a trailing conjunct outside the alternation on purpose. Inside an
 * arm it would filter one runtime and not the other, and the failure would look
 * like "the node has no errors" rather than like a bug.
 *
 * The node arm anchors on `^/srv/apps/SLUG/` rather than a substring match:
 * proven on live data that a substring filter for `subio` also returns
 * `/srv/apps/subio-2/app.log` — one tenant's lines leaking into another's
 * query. The anchor and trailing slash close that off. Slugs match
 * `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`, so they contain no regex
 * metacharacters and need no escaping here.
 */
export function appLogFilter(slug: string, opts: { minSeverity?: string } = {}): string {
  const cloudRun = `(resource.type=cloud_run_revision AND resource.labels.service_name=${slug})`;
  const node = `(resource.type=gce_instance AND labels."agent.googleapis.com/log_file_path"=~"^/srv/apps/${slug}/")`;
  const both = `(${cloudRun} OR ${node})`;
  return opts.minSeverity ? `${both} AND severity>=${opts.minSeverity.toUpperCase()}` : both;
}
