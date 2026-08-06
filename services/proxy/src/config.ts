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
  rootDomain: process.env.ROOT_DOMAIN ?? "supersonic.cv",
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
};
