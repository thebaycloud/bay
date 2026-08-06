import type { AppSpec } from "./fleet-spec";
import type { ProcessState } from "./fleet";

/**
 * What the platform knows about one app, answered from where the app RUNS.
 *
 * `GET /api/apps/[slug]` asked Cloud Run and nothing else, and that produced two
 * wrong answers for the same reason:
 *
 *  - An app on the fleet with no Cloud Run service fell through to a branch
 *    written for STATIC apps: empty revision, empty image, no env,
 *    `served: "static"`. Every app deployed since the fleet became the default
 *    target reads that way — measured 6 Aug, five apps deployed as a user, all
 *    placed on fleet-lab-2, all reporting `revision — image — env none` while
 *    serving traffic.
 *
 *  - An app on the fleet that still has a STALE Cloud Run service was answered
 *    FROM it. `a8ebb` serves fine on fleet-lab-1 and reported `ready: false`,
 *    because its abandoned Cloud Run revision cannot start. Blank output reads
 *    as "not known yet"; this reads as "your app is down", and sends someone to
 *    debug an app that is fine.
 *
 * Kept out of the route so it can be tested without a database, a node, or GCP —
 * everything below is a pure function of what the placement and the node already
 * reported.
 */
export interface AppStatus {
  slug: string;
  name: string;
  url: string;
  ready: boolean;
  region: string;
  revision: string;
  image: string;
  envKeys: string[];
  cloudsql: string;
  repo: string;
  /** Which runtime answered. The CLI prints it; support reads it first. */
  served: "fleet" | "cloudrun" | "static";
  /** The node holding it, when it is on the fleet. */
  node?: string;
  processes?: { name: string; kind: string; running: boolean }[];
}

/**
 * Which env var names an app has, secret-backed ones included.
 *
 * NAMES only, and that is load-bearing. `spec.secrets` maps an env var name to a
 * Secret Manager secret ID — the value never enters this table and must never
 * enter an API response either. Returning the IDs would put every app's
 * `app-<slug>-DATABASE_URL` in a response the dashboard renders.
 */
function envNames(spec: AppSpec): string[] {
  return [...Object.keys(spec.env ?? {}), ...Object.keys(spec.secrets ?? {})].sort();
}

/**
 * Whether the app is up, judged by what is RUNNING rather than by a probe alone.
 *
 * The three health states matter here. `true` is answering, `false` is asked and
 * silent, and ABSENT is nobody asked — a worker has no port. Requiring `true`
 * would report every worker-only app as down, which is exactly the defect the
 * nullable health field was introduced to end.
 *
 * So: any explicitly-false web process makes the app not ready; otherwise
 * anything running at all is up. Placed-but-running-nothing is not up.
 */
function readyFrom(running: ProcessState[]): boolean {
  if (running.length === 0) return false;
  return !running.some((p) => p.healthy === false);
}

/**
 * The app's database, which `status` reported as `none` for every app that has
 * ever existed — including ones whose env list, printed on the next line, is
 * full of `DATABASE_URL` and `PGDATABASE`.
 *
 * A database-backed app is given `DATABASE_URL`; on the fleet that arrives as a
 * secret reference. The database itself is named for the slug (`dbNameForSlug`),
 * so the name is derivable rather than stored.
 */
function databaseFor(slug: string, spec: AppSpec): string {
  const has = "DATABASE_URL" in (spec.secrets ?? {}) || "DATABASE_URL" in (spec.env ?? {});
  return has ? slug.replace(/-/g, "_").slice(0, 60) : "";
}

/**
 * Status for an app on the fleet, from its placement and the node's own report.
 *
 * `revision` stays empty on purpose. A fleet app has no Cloud Run revision, and
 * inventing one — the node name, the image digest — would make a field mean two
 * different things depending on where the app landed. `node` and `image` carry
 * the same information honestly.
 */
export function statusFromFleet(
  slug: string,
  node: string,
  spec: AppSpec,
  running: ProcessState[],
): AppStatus {
  const up = new Set(running.map((p) => p.process));
  return {
    slug,
    name: slug,
    url: `https://${slug}.supersonic.cv`,
    ready: readyFrom(running),
    region: "us-central1",
    revision: "",
    // What the node reports it is running beats what the placement asked for:
    // between a deploy and the node acting on it, those differ, and the honest
    // answer is the one that is executing.
    image: running[0]?.image || spec.image || "",
    envKeys: envNames(spec),
    cloudsql: databaseFor(slug, spec),
    repo: "",
    served: "fleet",
    node,
    processes: (spec.processes ?? []).map((p) => ({
      name: p.name,
      kind: p.kind,
      // `cron` and `release` are not long-running, so absence from the node's
      // running set is their normal state, not a fault.
      running: up.has(p.name),
    })),
  };
}
