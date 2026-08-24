import { rootDomains } from "./roots";

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
  loginUrl: process.env.LOGIN_URL ?? "https://app.thebay.cloud/login",
  /**
   * Every root the platform issues addresses under, CANONICAL FIRST.
   *
   * Plural because the rebrand needs both to answer at once: three live apps and
   * every installed CLI point at supersonic.cv, and thebay.cloud is the name from
   * here on. With one root, `<slug>.thebay.cloud` is not recognised as a platform
   * host at all — it falls through to the attached-domain lookup, finds no row,
   * and the app is unreachable at its own new address.
   *
   * `ROOT_DOMAINS=thebay.cloud,supersonic.cv`. `ROOT_DOMAIN` singular is still
   * read, because it is what this service is configured with today and a deploy
   * that ignores it takes the edge down.
   */
  /**
   * What a person calls us. Appears on the badge injected into every app, so a
   * literal here is our old brand showing up on somebody else's live site.
   *
   * Separate from the roots above because the two move apart: thebay.cloud was
   * added beside supersonic.cv without the name on the page changing at all.
   */
  // The default is the CURRENT name. It was "Supersonic" for months after the
  // cutover, and by this comment's own argument that put our retired brand on
  // every hosted app whose edge did not set the variable.
  productName: process.env.PRODUCT_NAME ?? "Bay",
  // From ./roots, which owns the parsing and the defaults — canonical first, the
  // new name first, and never empty.
  rootDomains: rootDomains(),
  /** Inject the "Runs on <product>" badge + owner toolbar into HTML pages. */
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
