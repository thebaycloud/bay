import type { HealthConfig } from "./app-config";

/**
 * Whether the app actually works, as opposed to whether the process stayed up.
 *
 * What this replaces returned `{ok: true}` on ANY exception — including its own
 * 20-second abort — with the comment "network/timeout (likely cold start) —
 * don't false-fail". So a deploy that never answered at all was published as a
 * success, and only 403, 5xx and one body regex could fail it. A framework's own
 * 404 page passed. A 200 serving a blank white screen passed.
 *
 * The instinct behind that catch was right: a cold start really can take longer
 * than one request, and failing a healthy app is the worse error. The mistake
 * was paying for it with the check itself. Retrying is how you survive a cold
 * start; passing is how you stop verifying.
 */

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export interface VerifyOptions {
  url: string;
  health: HealthConfig;
  /**
   * Whether the author DECLARED the health check.
   *
   * A declared expectation is enforced exactly: saying `expect: 200` and
   * receiving 302 is a broken deploy, and the whole point of the field is to say
   * so. An undefaulted check cannot be that strict — plenty of correct apps
   * redirect their root to /login or /app — so it only insists the app did not
   * answer with an error. Both catch what actually goes wrong: a timeout, a 404,
   * a 500.
   */
  strict: boolean;
  spaFallback?: boolean;
  headers?: Record<string, string>;
  /** How many times to re-ask before calling silence a failure. */
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Bodies that mean "the server is running and refused you anyway". */
const REFUSED = /blocked request|allowedhosts|is not allowed|cannot get \/|application error|internal server error/i;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function join(url: string, path: string): string {
  if (!path || path === "/") return url;
  return `${url.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function once(
  url: string,
  o: VerifyOptions,
): Promise<{ status: number; body: string } | { error: string }> {
  const doFetch = o.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20000);
  try {
    const r = await doFetch(url, { signal: ctrl.signal, headers: o.headers ?? {} });
    const body = (await r.text()).slice(0, 3000);
    return { status: r.status, body };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(to);
  }
}

const brief = (body: string) => body.replace(/\s+/g, " ").slice(0, 240);

/**
 * Ask the app for its health path until it answers or we run out of patience.
 *
 * The retry is what makes a cold start survivable without the check having to
 * lie. A container that has not finished starting refuses the connection or
 * times out; one that is never going to start does the same thing forever, and
 * the difference between them is only visible if you ask more than once.
 */
export async function verifyApp(o: VerifyOptions): Promise<VerifyResult> {
  const attempts = o.attempts ?? 4;
  const sleep = o.sleep ?? wait;
  const target = join(o.url, o.health.path);
  let last = "no response";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await once(target, o);

    if ("error" in r) {
      last = r.error;
      if (attempt < attempts) {
        o.log?.(`no answer yet (${r.error}) — retrying`);
        await sleep(Math.min(2000 * attempt, 8000));
        continue;
      }
      // Out of attempts. This is the line that used to return ok.
      return { ok: false, reason: `App never answered ${o.health.path}: ${last}` };
    }

    if (r.status === 403) {
      return { ok: false, reason: "App is sealed but the deployer identity cannot invoke it — check the run.invoker binding." };
    }
    // A 5xx during startup is worth one more ask; a 5xx that persists is real.
    if (r.status >= 500 && attempt < attempts) {
      last = `HTTP ${r.status}`;
      o.log?.(`${o.health.path} returned ${r.status} — retrying`);
      await sleep(Math.min(2000 * attempt, 8000));
      continue;
    }
    if (REFUSED.test(r.body)) {
      return { ok: false, reason: `App started but rejected the request: "${brief(r.body)}"` };
    }
    if (o.strict ? r.status !== o.health.expect : r.status >= 400) {
      return {
        ok: false,
        reason: o.strict
          ? `${o.health.path} returned HTTP ${r.status}, and the app declares it should return ${o.health.expect}: ${brief(r.body)}`
          : `${o.health.path} returned HTTP ${r.status}: ${brief(r.body)}`,
      };
    }

    // Only now is the app answering. A single further question, and only for an
    // app that claimed to be an SPA: React Router 404s on a refresh at /about,
    // which is invisible from the root and is the single most common way a
    // "successful" static deploy is broken for its users.
    if (o.spaFallback) {
      const probe = await once(join(o.url, "/__supersonic_spa_check"), o);
      if (!("error" in probe) && probe.status === 404) {
        return {
          ok: false,
          reason: "This app declares spaFallback, but an unknown path returns 404 — a refresh on any client-side route would break.",
        };
      }
    }
    return { ok: true };
  }

  return { ok: false, reason: `App never answered ${o.health.path}: ${last}` };
}
