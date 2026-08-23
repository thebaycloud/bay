import type { DeploymentFacts } from "./resolve";

/**
 * Telling an app where it actually lives.
 *
 * The repository has zero hits for ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS,
 * FORCE_SCRIPT_NAME, SECURE_PROXY_SSL_HEADER or X-Forwarded-*. An app was given
 * PORT, its database variables, STORAGE_BUCKET, GOOGLE_CLOUD_PROJECT and its
 * secrets — and no way to know its own hostname, its scheme, or the path prefix
 * it is mounted under.
 *
 * The platform owns this because the app cannot know it. An app behind a
 * TLS-terminating proxy has no way to discover it is behind one; it sees a plain
 * HTTP request to a Cloud Run hostname, and every absolute URL it generates from
 * that is wrong — OAuth redirect_uri, password-reset links, Set-Cookie Domain,
 * canonical tags, sitemaps.
 *
 * `framework` is the one token that selects the mapping. That is the entire
 * reason the field exists, and why it is authored rather than detected: the
 * mapping is a statement about how this app reads its configuration.
 *
 * HONEST LIMIT, worth stating because it bounds what this can do: an environment
 * variable only helps if the app reads that variable. `ALLOWED_HOSTS` reaches
 * Django only when its settings module does `os.environ["ALLOWED_HOSTS"]`, which
 * the common templates do and a hand-written settings.py may not.
 * SECURE_PROXY_SSL_HEADER is a Python tuple set in settings and cannot be
 * expressed as an env var at all — the proxy sending X-Forwarded-Proto (Phase
 * 7a) is what makes it correct once set, but setting it is the app's job. What
 * is injected here is what an app CAN read; the rest belongs in the prompts of
 * Phase 9.
 */

/**
 * Set on every app whatever its framework, because every app can read them.
 *
 * Emitted under BOTH names, and that is not a transition step that ends.
 *
 * These four are read by CODE WE DID NOT WRITE. Somebody's settings.py says
 * `os.environ["SUPERSONIC_HOSTNAME"]`, and it says so in a repository we have
 * no access to and no way to survey. Dropping the old name would break that app
 * on its next deploy, with a KeyError that names our variable and gives its
 * author no reason to connect it to a rebrand they were never told about.
 *
 * So the old names come out only when the people running apps have been told,
 * given a version to move to, and had time — not when the code is tidy. Until
 * then this costs four extra strings on a process environment.
 */
export function universalFacts(f: DeploymentFacts): Record<string, string> {
  const url = `${f.scheme}://${f.hostname}${f.pathPrefix === "/" ? "" : f.pathPrefix}`;
  const facts = {
    URL: url,
    HOSTNAME: f.hostname,
    SCHEME: f.scheme,
    PATH_PREFIX: f.pathPrefix,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(facts)) {
    out[`BAY_${k}`] = v;
    out[`SUPERSONIC_${k}`] = v;
  }
  return out;
}

const origin = (f: DeploymentFacts) => `${f.scheme}://${f.hostname}`;
const prefixed = (f: DeploymentFacts) => f.pathPrefix !== "/" && f.pathPrefix !== "";

/**
 * Runtime environment for a framework, beyond the universal facts.
 *
 * Every value here is one an app would otherwise have to hard-code — and
 * hard-coding it is what breaks the moment the app is deployed anywhere else.
 */
export function frameworkEnv(framework: string | undefined, f: DeploymentFacts): Record<string, string> {
  const name = (framework ?? "").toLowerCase();

  if (/django/.test(name)) {
    return {
      // Django returns 400 on EVERY request when Host is not in this list, which
      // reads as the app being down rather than as one missing setting.
      ALLOWED_HOSTS: f.hostname,
      // Without this a POST from the app's own form is rejected as a CSRF
      // failure, because Django compares Origin against a list it was never
      // given. Scheme-qualified: Django requires the scheme here.
      CSRF_TRUSTED_ORIGINS: origin(f),
      // Only meaningful when mounted under a prefix. Django builds every URL it
      // emits from this, so setting it at "/" would prepend nothing and setting
      // it wrongly would break every link at once.
      ...(prefixed(f) ? { FORCE_SCRIPT_NAME: f.pathPrefix } : {}),
    };
  }

  if (/rails/.test(name)) {
    return {
      RAILS_HOSTS: f.hostname,
      // Rails' force_ssl redirects on X-Forwarded-Proto, which the proxy now
      // sends. Without that header this setting is an infinite redirect loop,
      // which is why it is only safe to suggest after Phase 7a.
      FORCE_SSL: "true",
    };
  }

  if (/next/.test(name)) {
    return {
      // NextAuth builds its callback URLs from this and defaults to the request
      // host, which is the Cloud Run URL — so OAuth returns the user to an
      // address that is not the app.
      NEXTAUTH_URL: `${origin(f)}${prefixed(f) ? f.pathPrefix : ""}`,
    };
  }

  if (/fastapi|starlette|flask|quart/.test(name)) {
    return {
      // FastAPI/Starlette mount their docs and generated URLs under this. Flask
      // reads it via ProxyFix + APPLICATION_ROOT.
      ...(prefixed(f) ? { ROOT_PATH: f.pathPrefix, APPLICATION_ROOT: f.pathPrefix } : {}),
    };
  }

  return {};
}

/**
 * Build-time environment. Separate because these are baked into the bundle and
 * are useless at runtime — setting them after the build, which is what happened,
 * means the build ran without them and the value never reached the shipped
 * JavaScript.
 */
export function frameworkBuildEnv(framework: string | undefined, f: DeploymentFacts): Record<string, string> {
  const name = (framework ?? "").toLowerCase();

  if (/next/.test(name) && prefixed(f)) {
    // Next resolves basePath at build time into every emitted asset URL, so a
    // prefixed Next app whose bundle was built without it requests its
    // JavaScript from the wrong path and renders a blank page.
    return { NEXT_PUBLIC_BASE_PATH: f.pathPrefix };
  }
  if (/vite|react|vue|svelte/.test(name) && prefixed(f)) {
    return { VITE_BASE: f.pathPrefix };
  }
  return {};
}

/** Everything the platform knows about where this service lives, as env pairs. */
export function deploymentEnv(framework: string | undefined, f: DeploymentFacts): Record<string, string> {
  return { ...universalFacts(f), ...frameworkEnv(framework, f) };
}
