import { RAILPACK_FRONTEND } from "@/lib/build-config";

/**
 * Building on a BuildKit we own, instead of asking Cloud Build to find us one.
 *
 * ## What this is for
 *
 * `build` is 54 s of a measured 238 s deploy, and almost none of it is the app's
 * own work. Cloud Build schedules a worker, pulls a builder image, pulls a base
 * image, and only then touches the code — and the layer cache it uses is
 * `--cache-from type=registry`, downloaded in full onto a clean machine every
 * time. §3 of the architecture spec calls that "not a cache; it is a slow
 * registry", which is the whole argument in six words.
 *
 * A daemon that stays up keeps its cache on a local SSD. The second build of an
 * app touches almost nothing.
 *
 * ## Where this runs
 *
 * From the DEPLOY JOB, which already has the source — it cloned it, detected it
 * and wrote the plan. Cloud Build was a second machine we shipped the source to
 * so it could do what this one was already holding. Removing it removes a
 * scheduler from the critical path rather than making one faster.
 *
 * ## What the daemon is trusted with, and what it is not
 *
 * The image is pushed BY THE DAEMON, using a token this side sends it. So the
 * build host holds no long-lived registry credential: compromising it yields
 * whatever is in flight, not the ability to publish images tomorrow. Its own
 * service account can read nothing it needs for that.
 */

export interface BuildctlInput {
  /** The build context, and the directory holding `railpack-plan.json`. */
  dir: string;
  /** Fully-qualified image, without a tag — `:latest` is added here. */
  image: string;
  /** `tcp://host:port` of the daemon. */
  addr: string;
  /** Where the mTLS material is mounted. */
  certDir?: string;
  buildArgs?: { key: string; value: string }[];
}

const CERT_DIR = "/buildkit";

/**
 * The daemon's address, or null for "keep using Cloud Build".
 *
 * Trimmed and checked for emptiness rather than merely for presence: an env var
 * set to "" is the shape a half-finished rollout leaves behind, and reading it
 * as an address makes every build dial nothing and report a connection failure
 * instead of quietly taking the path that still works.
 */
export function buildPlaneHost(env: Record<string, string | undefined>): string | null {
  const addr = (env.BUILDKIT_HOST ?? "").trim();
  return addr || null;
}

/**
 * The argv for one build.
 *
 * `--local dockerfile=` names the DIRECTORY holding the plan, not the plan —
 * buildctl's vocabulary, inherited from the days when that directory held a
 * Dockerfile. Pointing it at the file yields a frontend that cannot find a plan
 * and says so in terms of neither.
 */
export function buildctlArgs(i: BuildctlInput): string[] {
  const certs = i.certDir ?? CERT_DIR;
  return [
    "--addr", i.addr,
    // All three together. A missing `--tlscert` against a daemon that requires
    // one fails in a TLS handshake, naming neither the certificate nor the build.
    "--tlscacert", `${certs}/ca/ca.pem`,
    "--tlscert", `${certs}/cert/client.pem`,
    "--tlskey", `${certs}/key/client-key.pem`,
    "build",
    // Railpack ships as a BuildKit frontend; the DAEMON fetches it, so nothing
    // about it has to exist on this side.
    "--frontend", "gateway.v0",
    "--opt", `source=${RAILPACK_FRONTEND}`,
    "--local", `context=${i.dir}`,
    "--local", `dockerfile=${i.dir}`,
    ...(i.buildArgs ?? []).flatMap((a) => ["--opt", `build-arg:${a.key}=${a.value}`]),
    "--output", `type=image,name=${i.image}:latest,push=true`,
    // The real cache is the daemon's own and stays on its disk. This inline copy
    // costs nothing and means a build somewhere else can still start warm.
    "--export-cache", "type=inline",
    "--progress", "plain",
  ];
}

/**
 * A `~/.docker/config.json` for Artifact Registry, from a short-lived token.
 *
 * buildctl reads registry credentials on the CLIENT and forwards them to the
 * daemon for the push. That is the property that keeps the build host free of
 * standing credentials, and it is worth not undoing later for convenience.
 *
 * `oauth2accesstoken` is the username Google's registries expect; the password
 * is the access token.
 */
export function dockerAuthConfig(registry: string, accessToken: string): string {
  const auth = Buffer.from(`oauth2accesstoken:${accessToken}`).toString("base64");
  return JSON.stringify({ auths: { [registry]: { auth } } });
}
