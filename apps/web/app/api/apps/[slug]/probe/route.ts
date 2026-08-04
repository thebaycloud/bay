export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { describeService } from "@/lib/gcloud";
import { identityToken } from "@/lib/gcp-rest";
import { probeSummary, probeCacheUsable, type ProbeResult, type ProbeSummary } from "@/lib/app-probe";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";

/** Long enough that a cold start is not reported as a dead app, short enough to render. */
const TIMEOUT_MS = 8000;
/** Only the head of the body is read: a preview is 120 characters and a response can be megabytes. */
const MAX_BODY = 4096;

/**
 * Ask the app itself, once, and report what it said.
 *
 * The dashboard's Live/Down is `ready`, which is Cloud Run's opinion of the
 * revision — true as soon as the container answered a startup probe on $PORT
 * once. An app can clear that and refuse every real request afterwards, which is
 * exactly what `epvmx` does with Django's DisallowedHost, and it drew the same
 * green LIVE as a working app.
 *
 * Requested by the card rather than rendered into the page: this reaches out to
 * a customer's app over the network, and putting it in the server render would
 * hold the whole dashboard behind the slowest app on it.
 */
/**
 * The last answer per app.
 *
 * A probe wakes a scale-to-zero app, so without this every dashboard load — and
 * every three-second poll while something is building — is a cold start per app.
 * See PROBE_TTL_MS, and see the comment on the grid's Thumb for the version of
 * this mistake that was already made and paid for.
 *
 * Per instance, which is all it needs to be: it exists to stop ONE person
 * refreshing from waking their apps repeatedly, and their refreshes land on the
 * same instance.
 */
const cache = new Map<string, { at: number; probe: ProbeResult & ProbeSummary }>();

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });

  // Checked after ownership, never before: a cache hit must not become a way to
  // read another account's app.
  const hit = cache.get(slug);
  if (probeCacheUsable(hit, Date.now())) return Response.json({ probe: hit!.probe, cached: true });

  let url: string;
  try {
    const svc = await describeService(slug);
    if (!svc.url) return Response.json({ probe: null, reason: "this app has no URL" });
    url = svc.url;
  } catch (e) {
    return Response.json({ probe: null, reason: e instanceof Error ? e.message : String(e) });
  }

  // A sealed app refuses an unauthenticated request with a 403 that is Cloud
  // Run's, not the app's — reporting that as the app's health would be the same
  // class of lie this endpoint exists to stop telling. No token means we did not
  // manage to ask, and that is reported as null rather than as a verdict.
  const token = await identityToken(url);
  if (!token) return Response.json({ probe: null, reason: "could not mint an ID token to call this app" });

  const started = Date.now();
  let result: ProbeResult;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      // A redirect to /login is an answer, and following it would time the wrong
      // request and report the wrong status.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    const body = await readHead(res);
    result = { code: res.status, ms, contentType: res.headers.get("content-type") ?? undefined, body };
  } catch {
    // Timeout, DNS, connection refused: nothing answered. Code 0 is what
    // probeSummary reads as "no answer" rather than inventing a status.
    result = { code: 0, ms: Date.now() - started };
  }

  const probe = { ...result, ...probeSummary(result) };
  cache.set(slug, { at: Date.now(), probe });
  return Response.json({ probe });
}

/** The first few KB, and never the whole body — a response can be megabytes and a preview is 120 chars. */
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
