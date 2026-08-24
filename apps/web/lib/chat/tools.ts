import { getTenantReadPool, dbNameForSlug } from "@/lib/db";
import { appLogs } from "@/lib/app-logs";
import { describeService, getErrors } from "@/lib/gcloud";
import { getDeploy } from "@/lib/deploys";
import { getAppBySlug, listGrants, listDomainGrants } from "@/lib/apps";
import { listPending } from "@/lib/requests";
import { envKeysFor } from "@/lib/env-keys";
import { websiteStats } from "@/lib/umami";
import type { Answer, Handler, Op } from "@/lib/chat/bridge";
import { appUrl } from "@/lib/brand";

/**
 * What each tool actually reads.
 *
 * Every one calls the same library function its sibling API route calls — the
 * route does not get hit over HTTP, and no query logic is written a second time.
 * That matters most for `db`: the SELECT-only guard exists in exactly one place
 * and this reuses it rather than reimplementing a check that has to be right.
 *
 * Answers are TRUNCATED, deliberately. An agent that reads a 40,000-row table into
 * its context has spent the run's whole budget on one call and will then be killed
 * for looping. Every cap says so in the answer, because a silently truncated result
 * is one an agent will confidently describe as complete.
 */

const CAP = 200;

function trunc<T>(rows: T[], cap = CAP): { rows: T[]; note?: string } {
  if (rows.length <= cap) return { rows };
  return {
    rows: rows.slice(0, cap),
    note: `showing the first ${cap} of ${rows.length} — narrow the query if you need the rest`,
  };
}

/** One SELECT, and nothing else. The same rule /db enforces, for the same reason. */
async function db(slug: string, sql: string): Promise<Answer> {
  const q = sql.trim().replace(/;+\s*$/, "");
  if (!q) return { ok: false, error: "no query given" };
  if (!/^select\b/i.test(q)) {
    return { ok: false, error: "only SELECT is allowed — this tool cannot change anything" };
  }
  if (q.includes(";")) return { ok: false, error: "one statement only" };
  try {
    // The READ-ONLY pool. The SELECT-only guard above stays exactly where it is;
    // this puts Postgres underneath it, refusing writes at the connection. That
    // guard is the only thing bounding a prompt injected through an app's own
    // rows, and it rested entirely on one regex.
    const pool = getTenantReadPool(dbNameForSlug(slug));
    const r = await pool.query(q);
    const { rows, note } = trunc(r.rows);
    return { ok: true, data: { columns: r.fields.map((f) => f.name), rows, note } };
  } catch (e) {
    // The database's own message, verbatim. "relation does not exist" tells the
    // agent to list tables; a wrapped "query failed" tells it nothing.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Two of these reads are OWNER-ONLY and live on the app's own hostname.
 *
 * `/_xray` and `/_dashboard/analytics` are answered by the proxy in front of the
 * tenant, and only for the owner — to anybody else the path means nothing and the
 * app answers it however it likes. A server-side fetch with no cookie IS anybody
 * else: the request was forwarded to the app, which returned its own HTML, and the
 * tool reported "the analytics tool is returning an invalid response". It was.
 *
 * So the caller's session is forwarded. That is sound rather than a shortcut: the
 * chat route has already established that this user owns this app, and the reading
 * being fetched is the one that user is entitled to. Nothing is forwarded anywhere
 * except that user's own app.
 */
export function toolsFor(slug: string, cookie?: string): Handler {
  const asOwner: HeadersInit = {
    Accept: "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
  };

  /**
   * Whether the forwarded session can possibly be recognised.
   *
   * The proxy validates a `.supersonic.cv` session cookie against the AUTH_SECRET
   * the control plane signed it with. Deployed, those are the same secret on the
   * same domain and the forward works. From a developer machine they are not: a
   * localhost session is a JWT signed with a local secret, so the PRODUCTION proxy
   * cannot validate it and correctly treats the read as a stranger's.
   *
   * Detected and stated rather than left to fail, because the failure is
   * indistinguishable from a real outage.
   *
   * Only `live` needs this now. `analytics` used to as well and no longer does: it
   * reads umami directly, which the control plane can always do. `live` genuinely
   * cannot be answered here — the edge reading lives in the proxy's own memory, and
   * no other process holds it.
   */
  // NODE_ENV, not a URL variable. `next dev` sets "development" and a built image
  // sets "production", which is exactly the distinction that matters and needs
  // nothing configured. NEXTAUTH_URL was the first choice and was wrong: it is not
  // set locally, and I could not verify it is set on the deployed control plane —
  // guessing wrong there would have disabled these two tools in production, which is
  // the only place they work.
  const deployed = process.env.NODE_ENV === "production";
  const localNote =
    "this reading is owner-only and answered by the proxy in production; a local " +
    "session cannot be validated there, so it is unavailable on a developer machine";

  return async (op: Op, arg: string): Promise<Answer> => {
    try {
      switch (op) {
        case "db":
          return await db(slug, arg);

        case "logs": {
          const limit = Math.min(Math.max(Number(arg) || 60, 1), CAP);
          const lines = await appLogs(slug, { limit });
          return { ok: true, data: trunc(lines, limit) };
        }

        case "errors": {
          const limit = Math.min(Math.max(Number(arg) || 40, 1), CAP);
          const errs = await getErrors(slug);
          return { ok: true, data: trunc(errs, limit) };
        }

        case "analytics": {
          // The window is chosen from a list rather than parsed: it reaches umami, and
          // the panel's own analytics read does the same for the same reason.
          const range = ["1d", "7d", "30d"].includes(arg) ? arg : "1d";
          const app = await getAppBySlug(slug);
          if (!app?.umami_website_id || !app.analytics_enabled) {
            return { ok: true, data: { on: false, note: "analytics is off for this app, so nobody is being counted" } };
          }
          // Read umami DIRECTLY. This used to fetch the app's own proxy at
          // /_dashboard/analytics — an owner-only endpoint on a different host — which
          // needed a session cookie a server cannot reliably present, only worked from
          // a deployed control plane, and depended on Cloud Run egress reaching a
          // public hostname to answer a question the control plane can answer itself.
          // It failed three different ways before it failed silently.
          const stats = await websiteStats(app.umami_website_id, range);
          if (!stats) {
            // Unreachable is NOT zero. "Nobody came" and "we could not count" are
            // opposite answers, and reading one as the other is how a dashboard lies.
            return { ok: false, error: "umami could not be reached, so the count is unknown — this is not the same as nobody having visited" };
          }
          return {
            ok: true,
            data: {
              ...stats,
              note: "visitors are PEOPLE, counted by umami — never add these to the edge's request counts",
            },
          };
        }

        case "deploys": {
          const d = await getDeploy(slug);
          if (!d) return { ok: true, data: { note: "no deploy on file for this app" } };
          // `status` answers doneness; `stage` is the last step that RAN. Both are
          // returned, labelled, because reading stage for doneness is the mistake
          // that left every finished app saying "shipping".
          return {
            ok: true,
            data: {
              status: d.status,
              stage: d.stage,
              error: d.error ?? null,
              url: d.url ?? null,
              name: d.name ?? null,
              note: "status is whether it finished; stage is only the last step that ran",
            },
          };
        }

        case "keys": {
          // envKeysFor, NOT describeService: a fleet app has no Cloud Run service and
          // its variables come from its placement. Reading only the service made this
          // answer "no environment keys configured" about an app with five, while the
          // Dev screen beside it listed all five.
          const { keys, note } = await envKeysFor(slug);
          if (!keys) {
            return { ok: true, data: { names: [], note: note ?? "could not be determined" } };
          }
          return {
            ok: true,
            data: {
              names: keys,
              note: "names only — values are never readable, and whether a key still works is not recorded anywhere",
            },
          };
        }

        case "access": {
          const app = await getAppBySlug(slug);
          const [grants, domains, requests] = await Promise.all([
            listGrants(slug), listDomainGrants(slug), listPending(slug),
          ]);
          // `domains` is people too — a rule for "luwo.ai" admits everyone there
          // with a verified address, so an answer that listed only `grants`
          // would under-report who can open the app.
          return { ok: true, data: { visibility: app?.visibility ?? "private", grants, domains, requests } };
        }

        case "live": {
          if (!deployed) return { ok: false, error: localNote };
          // The edge reading, from the proxy in front of this app. It counts
          // REQUESTS; analytics counts PEOPLE. Never add them together.
          const r = await fetch(`${appUrl(slug)}/_xray`, {
            headers: asOwner,
          });
          const ct = r.headers.get("content-type") ?? "";
          if (!ct.includes("json")) {
            return {
              ok: false,
              error: "the edge reading came back as a page rather than JSON — this read was not recognised as the owner's",
            };
          }
          const j = await r.json();
          return {
            ok: true,
            data: {
              paths: (j?.live?.paths ?? []).slice(0, 40),
              here: j?.live?.here ?? null,
              note: "these are requests, not people — one page view with eleven assets is eleven requests",
            },
          };
        }

        case "describe": {
          const [svc, envs] = await Promise.all([
            describeService(slug).catch(() => null),
            envKeysFor(slug).catch(() => ({ keys: null as string[] | null })),
          ]);
          if (!svc) {
            return {
              ok: true,
              data: {
                note: "this app has no Cloud Run service of its own — it runs on a fleet node",
                envKeys: envs.keys ?? [],
              },
            };
          }
          return {
            ok: true,
            data: {
              url: svc.url,
              image: svc.image,
              region: svc.region,
              envKeys: envs.keys ?? svc.envKeys,
              hasDatabase: Boolean(svc.cloudsql),
              // Deliberately included: most apps are folder uploads with no repo on
              // file, and an agent that knows that stops asking to read code.
              repo: svc.repo || null,
            },
          };
        }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
