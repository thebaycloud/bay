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
function memoryToBytes(limit: string | undefined): number {
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
function cpuToShares(limit: string | undefined): number {
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
export function repointedForFleet(dsn: string): string {
  return repointed(dsn);
}

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

/**
 * Does this image belong to this app?
 *
 * THE CHECK THAT WAS MISSING, and it cost a batch of five. Four of them shared
 * one image — `cloud-run-source-deploy/runner-node@sha256:82df02…` — because the
 * runner lane pointed a single prebuilt image at a code bundle fetched at start.
 * The app's code is not in that image. Placing it on a node places an empty
 * runtime, and the app would have started, listened, and served the runner's
 * idea of nothing.
 *
 * Written against the SLUG rather than against the name `runner-node`, which is
 * one lane's spelling and will change. An app built by this platform is pushed
 * to `…/cloud-run-source-deploy/<slug>`, so the last path segment is the test.
 */
export function imageBelongsTo(slug: string, image: string): boolean {
  const repo = image.split("@")[0].split(":")[0];
  return repo.slice(repo.lastIndexOf("/") + 1) === slug;
}

/**
 * Is this app served by the static service rather than by a container?
 *
 * ADR 0001 keeps static apps on Cloud Run permanently, and there is no container
 * to move even if it did not. `o6b54` was marked `fleet` in that same batch and
 * its `run_url` pointed at `supersonic-static` — so the revert, which rebuilt
 * the URL from the slug, sent it somewhere it had never been. Restoring it took
 * a second statement, and the tool now records what it replaces instead of
 * reconstructing it.
 */
export function servedByStatic(runUrl: string | null | undefined): boolean {
  return !!runUrl && runUrl.includes("supersonic-static");
}

/**
 * Is this app's connection string locked inside a secret?
 *
 * THE REFUSAL THAT STOPS THE MIGRATION WHERE IT STANDS, and it was learned the
 * expensive way: `dp7ul`, `kngsu` and `m4vtu` were placed, started, and answered
 * 500 to everything. Their DSN is not an env value — it is a Secret Manager
 * entry, and the stored value reads `…@127.0.0.1:5432/<db>`, which is Cloud
 * Run's sidecar and is nothing at all on a node.
 *
 * `repointed` cannot help: the spec carries a REFERENCE, which is invariant 3
 * and not negotiable. Neither can rewriting the secret, because the Cloud Run
 * copy is still serving from it — the two runtimes would need different values
 * of one secret at the same moment, which is the definition of a cutover that
 * cannot be atomic.
 *
 * What it needs is a second secret written at the fleet address and referenced
 * only by the fleet spec, so both runtimes are correct at once and the old one
 * is deleted after. That is a design decision about how many copies of a
 * password may exist, and it should be made deliberately rather than by an
 * adoption tool at three in the morning.
 */
export function dsnIsSealed(
  env: { name: string; value?: string; valueFrom?: unknown }[],
): boolean {
  return env.some((e) => /URL$/.test(e.name) && e.valueFrom && e.value === undefined);
}

/**
 * The suffix that marks a secret written at the fleet's database address.
 *
 * Inside the app's own namespace on purpose: the secret broker authorises by
 * `ownedBy(slug, id)`, which requires `app-<slug>-`, so a copy named any other
 * way would be refused at the exact moment a node asked for it.
 */
export const FLEET_SECRET_SUFFIX = "-fleet";

/**
 * The same secret references, with the connection string pointed at its fleet
 * copy.
 *
 * WHY A COPY AND NOT A REWRITE. The stored DSN reads `…@127.0.0.1:5432/<db>`,
 * which is Cloud Run's sidecar. Rewriting it in place would break the Cloud Run
 * service still serving from it: two runtimes would need different values of one
 * secret at the same moment. A second secret makes both correct at once, and the
 * original is deleted once the app is off Cloud Run.
 *
 * ONLY THE CONNECTION STRING. `POSTGRES_PASSWORD`, `PGPASSWORD`, `DB_PASSWORD`
 * and `SUPERSONIC_DB_PASSWORD` hold the same value on either runtime — they
 * describe the database, not the route to it — so exactly one secret per app is
 * duplicated and a password lives in two places for the length of a migration
 * rather than four.
 */
export function withFleetDsn(
  slug: string,
  refs: { key: string; name: string }[],
): { key: string; name: string }[] {
  return refs.map((r) =>
    /URL$/.test(r.key) ? { ...r, name: `${r.name}${FLEET_SECRET_SUFFIX}` } : r);
}
