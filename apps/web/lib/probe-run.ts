import { getPool } from "./db";
import { identityToken } from "./gcp-rest";
import { probeSummary, probeCacheUsable, type ProbeResult, type ProbeSummary } from "./app-probe";

const DB = "supersonic_platform";

/** Long enough that a cold start is not reported as a dead app, short enough to render. */
const TIMEOUT_MS = 8000;
/** Only the head of the body is read: a preview is 120 characters and a response can be megabytes. */
const MAX_BODY = 4096;

/**
 * Asking an app how it is, extracted from the route that used to own it.
 *
 * It moved because one probe per request stopped being the only caller: the
 * dashboard asks about every app it is showing at once, and both entry points
 * have to share ONE cache. Two caches would mean the batch endpoint waking apps
 * the single endpoint had just woken.
 */
export type Probe = ProbeResult & ProbeSummary;

const cache = new Map<string, { at: number; probe: Probe }>();

/**
 * Where to send the request, without asking Cloud Run.
 *
 * This used to be `describeService(slug)` — a Cloud Run Admin API read that also
 * calls `listWorkers`, so two upstream round trips per app per probe, for a URL
 * that is already written in our own database when the app goes live. The apps
 * table has it.
 *
 * A static app has no service of its own (one shared server fronts all of them),
 * so its `run_url` points somewhere useless to probe. Its public host works and
 * is deterministic, which also fixes something: those apps have never been
 * probed at all, and reported "we could not ask" forever.
 */
interface ProbeTarget { url: string; authed: boolean }

/**
 * Which address belongs to THIS app, decided from the four shapes `run_url`
 * actually holds in production:
 *
 *   https://<slug>-uyuwsbguuq-…    a Cloud Run service of its own
 *   https://supersonic-static-…    the shared static server, fronting many apps
 *   http://8.232.255.172           a fleet address, shared the same way
 *   null / ""                      never recorded
 *
 * Only the first is this app's. The rest are shared infrastructure, and probing
 * them would report the health of a server that happens to serve this app along
 * with a dozen others. A Cloud Run service is named for its slug, which is what
 * makes the first case recognisable at all.
 *
 * The public host is right for every other case: it is deterministic, it goes
 * through our proxy, and the proxy authenticates on its own — so no token is
 * minted for it. A token with the wrong audience would be answered by the
 * platform rather than by the app, which is the class of lie this whole
 * endpoint exists to stop telling.
 */
function probeTarget(slug: string, runUrl: string | null | undefined): ProbeTarget {
  const own = (() => {
    if (!runUrl) return false;
    try {
      return new URL(runUrl).host.startsWith(`${slug}-`);
    } catch {
      return false;
    }
  })();
  return own ? { url: runUrl!, authed: true } : { url: `https://${slug}.supersonic.cv`, authed: false };
}

async function targetOf(slug: string, ownerId: string): Promise<ProbeTarget | null> {
  const r = await getPool(DB).query(
    "SELECT run_url FROM apps WHERE slug = $1 AND owner_id = $2",
    [slug, ownerId],
  );
  if (!r.rows[0]) return null;
  return probeTarget(slug, r.rows[0].run_url);
}

/** The first few KB, and never the whole body. */
async function readHead(res: Response): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  try {
    const { value } = await reader.read();
    return value ? new TextDecoder().decode(value.slice(0, MAX_BODY)) : undefined;
  } catch {
    return undefined;
  } finally {
    // Otherwise the connection stays open for a body nobody is going to read.
    void reader.cancel().catch(() => {});
  }
}

export interface ProbeAnswer { probe: Probe | null; cached?: boolean; reason?: string }

/**
 * One app, asked once — or remembered.
 *
 * Ownership is the caller's job and is assumed done: every entry point here
 * checks it before calling, and the cache is only ever read for a slug that
 * check has already passed.
 */
export async function probeApp(slug: string, ownerId: string): Promise<ProbeAnswer> {
  const hit = cache.get(slug);
  if (probeCacheUsable(hit, Date.now())) return { probe: hit!.probe, cached: true };

  let target: { url: string; authed: boolean } | null;
  try {
    target = await targetOf(slug, ownerId);
  } catch (e) {
    return { probe: null, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!target) return { probe: null, reason: "this app has no URL" };

  let headers: Record<string, string> = {};
  if (target.authed) {
    // A sealed app refuses an unauthenticated request with a 403 that is Cloud
    // Run's, not the app's. No token means we did not manage to ask, and that is
    // reported as null rather than as a verdict.
    const token = await identityToken(target.url);
    if (!token) return { probe: null, reason: "could not mint an ID token to call this app" };
    headers = { Authorization: `Bearer ${token}` };
  }

  const started = Date.now();
  let result: ProbeResult;
  try {
    const res = await fetch(target.url, {
      headers,
      // A redirect to /login is an answer, and following it would time the wrong
      // request and report the wrong status.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    result = { code: res.status, ms, contentType: res.headers.get("content-type") ?? undefined, body: await readHead(res) };
  } catch {
    // Timeout, DNS, connection refused: nothing answered. Code 0 is what
    // probeSummary reads as "no answer" rather than inventing a status.
    result = { code: 0, ms: Date.now() - started };
  }

  const probe = { ...result, ...probeSummary(result) };
  cache.set(slug, { at: Date.now(), probe });
  return { probe };
}

/**
 * How many apps may be in flight at once.
 *
 * A probe is mostly waiting — on a cold start, on a network — so this is not
 * about CPU. It is about not opening twenty-six sockets to twenty-six apps in
 * the same tick, and about the batch answering in a bounded time: with a cap,
 * the slowest possible answer is ceil(n / CAP) × the timeout, which is a number
 * we can reason about.
 */
const CONCURRENCY = 12;

/**
 * Every app in the list, reported one at a time as each answers.
 *
 * The callback is the point. Collecting all of them and returning a map meant
 * the page showed nothing until the slowest cold start finished — measured at
 * 2.5–4.5s for a full dashboard, during which every card sat blank. Card-by-card
 * updates are what the old one-request-per-card version got right by accident,
 * and they survive here without twenty-six connections.
 */
export async function probeMany(
  slugs: string[],
  ownerId: string,
  onResult: (slug: string, probe: Probe | null) => void,
): Promise<void> {
  const queue = [...slugs];

  const worker = async () => {
    for (;;) {
      const slug = queue.shift();
      if (!slug) return;
      try {
        onResult(slug, (await probeApp(slug, ownerId)).probe);
      } catch {
        // One app that cannot be reached must not take the other twenty-five
        // with it; the card renders its fallback status and the rest still land.
        onResult(slug, null);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}
