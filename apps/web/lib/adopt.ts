import { FLEET_DB } from "@/lib/db-address";
import { databaseEnvNames } from "@/lib/lanes";

/**
 * Moving a live Cloud Run app onto the fleet WITHOUT rebuilding it.
 *
 * ## Why adoption rather than a redeploy
 *
 * Twenty apps still serve from Cloud Run, and the obvious migration — redeploy
 * each one — cannot be run: the platform does not keep the repository a deployed
 * app came from. `apps` has no `repo_url`, and the deploy run that carried it is
 * deleted when the run finishes. There is nothing to redeploy FROM.
 *
 * What does exist is the image the app is serving right now, and everything the
 * running service was configured with. That is enough to place it on a node, and
 * it has the additional property that the artifact does not change: an adoption
 * that goes wrong is a placement problem, never a build problem.
 *
 * ## The one thing that cannot be copied
 *
 * On Cloud Run the database is a sidecar on `127.0.0.1`. On a node it is one
 * proxy per host at `10.200.0.1`, reached over the sandbox bridge because every
 * sandbox has its own loopback. Carrying `PGHOST=127.0.0.1` across produces an
 * app that starts, passes a health check on `/`, and fails every request that
 * touches data — the exact shape both the secret path and the database path are
 * built to refuse. So the platform's own database variables are dropped and
 * restated at the fleet address; everything else belongs to the app and travels
 * untouched.
 *
 * ## What this module is not
 *
 * It does not place anything. It turns a service description into the input a
 * placement needs, so that the part with judgement in it can be tested without a
 * cloud — the same split `lib/placement-plan.ts` has against the reconciler.
 */

/** The subset of a Cloud Run service this reads. Matches the v1 API shape. */
export interface RunService {
  spec: {
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        containers: {
          image: string;
          ports?: { containerPort?: number; name?: string }[];
          resources?: { limits?: { cpu?: string; memory?: string } };
          env?: {
            name: string;
            value?: string;
            valueFrom?: { secretKeyRef: { name: string; key: string } };
          }[];
        }[];
      };
    };
  };
}

export interface AdoptionInput {
  slug: string;
  /** As the service names it — possibly a tag. See `imageIsTag`. */
  image: string;
  /**
   * True when `image` ends in a tag rather than a digest.
   *
   * A release built on `:latest` is a release that means something different
   * tomorrow, so the caller must resolve this before recording one. Reported
   * rather than resolved here because resolving it is a registry call, and this
   * module is the half that can be tested without a cloud.
   */
  imageIsTag: boolean;
  /** `KEY=value`, with the platform's database variables restated for the fleet. */
  env: string[];
  /** Env name → Secret Manager id. References, never values. */
  secrets: { key: string; name: string }[];
  port: number;
  memoryBytes: number;
  cpuShares: number;
}

/** Cloud Run writes `2Gi`, `512Mi`, `1G`. Bytes, or 0 when it says nothing. */
export function memoryToBytes(limit: string | undefined): number {
  if (!limit) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([GMK]i?)?B?$/i.exec(limit.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || "").toLowerCase();
  const scale: Record<string, number> = {
    "": 1, k: 1000, ki: 1024, m: 1000 ** 2, mi: 1024 ** 2, g: 1000 ** 3, gi: 1024 ** 3,
  };
  return Math.round(n * (scale[unit] ?? 1));
}

/** Cloud Run writes `1`, `2`, `500m`. One CPU is 1024 shares, as the agent counts. */
export function cpuToShares(limit: string | undefined): number {
  if (!limit) return 0;
  const t = limit.trim();
  const milli = t.endsWith("m");
  const n = Number(milli ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return 0;
  return Math.round((milli ? n / 1000 : n) * 1024);
}

const DEFAULT_PORT = 8080;

export function adoptionInput(slug: string, service: RunService): AdoptionInput {
  const c = service.spec.template.spec.containers[0];
  const env = c.env ?? [];

  const secrets = env
    .filter((e) => e.valueFrom)
    .map((e) => ({ key: e.name, name: e.valueFrom!.secretKeyRef.name }));

  // Every name the platform writes for a database it provisioned is dropped
  // here, not overwritten later: a name appearing twice is decided by ordering,
  // and the losing side of that coin is an app that cannot reach its database.
  // `restateDatabaseAt` states the same rule for the deploy path.
  const owned = new Set(databaseEnvNames());
  const plain = env.filter((e) => e.value !== undefined && !owned.has(e.name));

  // Restated ONLY where the service had them. An app with no database gains no
  // database variables — inventing them would point it at a proxy it never uses.
  const hadDatabase = env.some((e) => owned.has(e.name));
  const restated = hadDatabase
    ? env
        .filter((e) => e.value !== undefined && owned.has(e.name))
        .map((e) => `${e.name}=${addressed(e.name, e.value!)}`)
    : [];

  return {
    slug,
    image: c.image,
    imageIsTag: !c.image.includes("@sha256:"),
    env: [...plain.map((e) => `${e.name}=${e.value}`), ...restated],
    secrets,
    port: c.ports?.[0]?.containerPort ?? DEFAULT_PORT,
    memoryBytes: memoryToBytes(c.resources?.limits?.memory),
    cpuShares: cpuToShares(c.resources?.limits?.cpu),
  };
}

/**
 * One database variable, pointed at the fleet's proxy instead of Cloud Run's.
 *
 * Only the host and port move. The user, the database name and the password
 * reference are the same values on either runtime — they describe the database,
 * not the route to it.
 */
function addressed(name: string, value: string): string {
  if (/^(POSTGRES_SERVER|POSTGRES_HOST|PGHOST|DB_HOST)$/.test(name)) return FLEET_DB.host;
  if (/^(POSTGRES_PORT|PGPORT|DB_PORT)$/.test(name)) return FLEET_DB.port;
  if (/URL$/.test(name)) return repointed(value);
  return value;
}

/**
 * A connection STRING moved to the fleet's proxy.
 *
 * This is the case the first version of this module missed, and it cost the
 * first adoption. A DSN is not a host variable, so rewriting `PGHOST` and its
 * siblings left it untouched — and Cloud Run's own form is a UNIX SOCKET:
 *
 *   postgresql://user:pw@/shop?host=/cloudsql/<project>:<region>:<instance>
 *
 * That socket is mounted by the `cloudsql-instances` annotation and exists
 * nowhere on a node. The app was placed, started, listened, and answered 500 to
 * everything — while the edge went on returning 401, because the sign-in gate
 * fires before the upstream is ever called.
 *
 * ONLY OUR OWN DATABASE IS MOVED. An app may arrive with its own DSN pointing at
 * Supabase or Neon, and repointing that at our proxy would take a working app
 * off its data. Ours is recognisable two ways and no others: the `/cloudsql/`
 * socket, and Cloud Run's sidecar address.
 */
function repointed(dsn: string): string {
  if (!/^[a-z+]+:\/\//i.test(dsn)) return dsn;

  // The socket form. `host=/cloudsql/…` in the query, and the path holds the
  // database name.
  const socket = /[?&]host=\/cloudsql\//.test(dsn);
  const sidecar = /@127\.0\.0\.1(:\d+)?\//.test(dsn);
  if (!socket && !sidecar) return dsn;

  // Parsed by hand rather than with URL: a socket-form DSN has an empty host,
  // which URL rejects, and that is exactly the form being fixed.
  const scheme = dsn.slice(0, dsn.indexOf("://") + 3);
  const rest = dsn.slice(scheme.length);
  const at = rest.lastIndexOf("@");
  const credentials = at >= 0 ? rest.slice(0, at) : "";
  const after = at >= 0 ? rest.slice(at + 1) : rest;

  const q = after.indexOf("?");
  const path = (q >= 0 ? after.slice(0, q) : after).replace(/^[^/]*/, "");
  const query = q >= 0 ? after.slice(q) : "";

  // `host=/cloudsql/…` described where the database was; it is now in the
  // address, and leaving it would send the app back to a socket.
  const kept = query
    .replace(/([?&])host=[^&]*/, "$1")
    .replace(/[?&]$/, "")
    .replace(/\?&/, "?");

  return `${scheme}${credentials}${credentials ? "@" : ""}${FLEET_DB.host}:${FLEET_DB.port}${path}${kept}`;
}
