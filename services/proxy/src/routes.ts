/**
 * Which of an app's services a request belongs to.
 *
 * An app used to be one Cloud Run service and one URL, so the proxy needed no
 * routing at all: `apps.run_url` was the answer to every request. That model
 * cannot express the shape people keep building — a Next.js frontend beside a
 * Python API — because a Next app doing SSR is itself a server and cannot be
 * mounted inside FastAPI. Two servers need two Cloud Run services.
 *
 * They are routed by PATH on one hostname rather than given a hostname each,
 * and that choice is doing real work:
 *   - Same origin, so there is no CORS. The frontend calls `/api/…` relative,
 *     which is how these apps are already written behind a dev proxy. Separate
 *     hostnames would make every user configure CORS correctly, and they will
 *     not.
 *   - Nothing to inject at build time. `NEXT_PUBLIC_API_URL` is frozen into the
 *     bundle when it is built; a relative path has nothing to freeze.
 *   - One auth gate. The proxy authenticates once and forwards; two origins
 *     would mean a browser hitting a second gated host, and the private-app
 *     model coming apart.
 *   - One URL to share, one app in the dashboard, because it is one app.
 */

export interface Route {
  /** Path prefix, e.g. "/api". "/" catches everything not matched by a longer one. */
  path: string;
  /** The Cloud Run URL serving it. */
  url: string;
}

/** Rejects anything that is not a usable prefix, so bad data cannot swallow an app's traffic. */
function usable(r: Route): boolean {
  return Boolean(r && typeof r.path === "string" && r.path.startsWith("/") && typeof r.url === "string" && r.url);
}

/**
 * The service for a request path — longest matching prefix wins.
 *
 * Longest-prefix rather than first-match because the order routes happen to be
 * stored in must not decide where traffic goes: with `/` listed before `/api`,
 * first-match would send every API call to the frontend, and the failure would
 * look like the backend being down.
 *
 * A prefix matches only at a path BOUNDARY: `/api` matches `/api` and `/api/x`,
 * never `/apiary`. Getting that wrong routes a real URL to the wrong service and
 * is close to impossible to spot from the outside.
 */
function bestRoute(routes: Route[] | null | undefined, path: string): Route | null {
  if (!Array.isArray(routes) || routes.length === 0) return null;
  // Query strings and fragments are not part of the match.
  const p = (path || "/").split(/[?#]/)[0] || "/";
  let best: Route | null = null;
  for (const r of routes) {
    if (!usable(r)) continue;
    const prefix = r.path.length > 1 && r.path.endsWith("/") ? r.path.slice(0, -1) : r.path;
    const matches = prefix === "/" || p === prefix || p.startsWith(prefix + "/");
    if (!matches) continue;
    if (!best || prefix.length > (best.path === "/" ? 0 : best.path.length)) best = { ...r, path: prefix };
  }
  return best;
}

export function pickRoute(routes: Route[] | null | undefined, path: string, fallback: string | null): string | null {
  const best = bestRoute(routes, path);
  return best ? best.url : fallback;
}

/**
 * The prefix the serving service is mounted under, or null when it owns "/".
 *
 * The service behind `/api` receives `/api/items` verbatim — `forward.ts` does
 * not strip the prefix — so it is the only party that can be wrong about where
 * it lives, and it has no way to find out. This is what becomes
 * `x-forwarded-prefix`, so the app can generate links under `/api` instead of
 * emitting absolute paths that land on the frontend service.
 */
export function pickPrefix(routes: Route[] | null | undefined, path: string): string | null {
  const best = bestRoute(routes, path);
  return best && best.path !== "/" ? best.path : null;
}

/** Parse whatever the database returned into routes, tolerating null and junk. */
export function parseRoutes(value: unknown): Route[] | null {
  if (!value) return null;
  let raw: unknown = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(raw)) return null;
  const routes = raw.filter((r): r is Route => usable(r as Route));
  return routes.length ? routes : null;
}
