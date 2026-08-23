function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const PROD = process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  authSecret: required("AUTH_SECRET"),
  /** Must match apps/web auth.config.ts exactly — it is also the decode salt. */
  sessionCookieName: PROD ? "__Secure-authjs.session-token" : "authjs.session-token",
  loginUrl: process.env.LOGIN_URL ?? "https://app.supersonic.cv/login",
  /**
   * The root every URL we BUILD is built from. One value, deliberately: a
   * redirect that sent people to a domain being retired would be manufacturing
   * new traffic for it.
   */
  /** What a person calls us. Appears on the badge injected into every app. */
  productName: process.env.PRODUCT_NAME ?? "Supersonic",
  rootDomain: process.env.ROOT_DOMAIN ?? "supersonic.cv",
  /**
   * Every root we SERVE, canonical first.
   *
   * During a rename both the old and the new domain issue the same apps, so
   * nobody's bookmark breaks on cutover day. LEGACY_ROOT_DOMAINS is a
   * comma-separated list and is empty in the steady state, which makes this
   * exactly equal to [rootDomain] — the behaviour before it existed.
   */
  servedRootDomains: [
    process.env.ROOT_DOMAIN ?? "supersonic.cv",
    ...(process.env.LEGACY_ROOT_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  ],
  /** Inject the "Runs on Supersonic" badge + owner toolbar into HTML pages. */
  injectOverlay: process.env.INJECT_OVERLAY !== "0",
  /**
   * Whether plan limits are enforced — must match GATING_ENABLED in apps/web.
   *
   * The edge only reads it for one decision (may this app hide the badge), but
   * it has to be the same flag: a proxy that enforced plans while the control
   * plane did not would take the badge off apps whose owners the dashboard is
   * still treating as unlimited.
   */
  gatingEnabled: process.env.GATING_ENABLED === "1",
  /**
   * What the fleet's node router checks. Empty means fleet requests go unsigned,
   * which the node only accepts while its own gate is off.
   *
   * Not `required()`: an empty value has to keep working, because the proxy runs
   * with no secret at all for the whole window between deploying this and
   * turning the node's gate on.
   *
   * Trimmed, and that is not cosmetic. Node refuses to put a value containing a
   * newline in a header, so an untrimmed secret does not degrade — it throws on
   * every fleet-bound request and serves 502 for all nineteen apps, from here,
   * before the node is contacted. `openssl rand` emits a trailing newline by
   * default, so this is the ordinary way to create one, not an exotic mistake.
   */
  edgeSecret: (process.env.FLEET_EDGE_SECRET ?? "").trim(),
  /**
   * The shared umami instance, reachable by the platform and by nothing else.
   *
   * Empty means analytics is off everywhere: no tracker is injected, `/_bay/*`
   * answers 404 exactly as any other unclaimed path would, and the panel says
   * so rather than showing zeroes. That is the state this proxy is in on a
   * developer's machine and in every environment where umami has not been
   * deployed yet, and all of it has to keep working.
   */
  umamiUrl: (process.env.UMAMI_URL ?? "").replace(/\/$/, "").trim(),
  umamiUser: process.env.UMAMI_USER ?? "admin",
  umamiPassword: (process.env.UMAMI_PASSWORD ?? "").trim(),
};
