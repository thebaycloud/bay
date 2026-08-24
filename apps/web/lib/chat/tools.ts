import { getTenantReadPool, dbNameForSlug } from "@/lib/db";
import { allShapes, readStats } from "@/lib/db-catalog";
import { appLogs } from "@/lib/app-logs";
import { readLogs, ALL_SINCE, SOURCES, LEVELS, type Query, type Source, type Level } from "@/lib/logs";
import {
  bucketForSlug, describeService, getErrors, listBucketObjectsCached, listJobs,
} from "@/lib/gcloud";
import { listDomains } from "@/lib/domains";
import { probeApp } from "@/lib/probe-run";
import { orderingFor, describeOrdering, recencyColumn } from "@/lib/db-browse";
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

/**
 * `./logs <something>` — a filter, not a line count.
 *
 * Three shapes, because an agent should not have to learn a query language to
 * ask "what broke": a bare level, `key=value` for a facet, and anything else as
 * free text. Unknown keys are ignored rather than refused — an agent that guesses
 * `severity=error` should get logs, not a lecture.
 */
export function parseAgentQuery(arg: string): Query {
  const q: Query = { since: ALL_SINCE };
  const words: string[] = [];

  for (const token of String(arg ?? "").trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq).toLowerCase();
      const value = token.slice(eq + 1);
      if (key === "source" && (SOURCES as string[]).includes(value)) {
        q.sources = [...(q.sources ?? []), value as Source];
        continue;
      }
      if (key === "level" && (LEVELS as string[]).includes(value)) { q.minLevel = value as Level; continue; }
      if (key === "status") { q.status = Number(value) || null; continue; }
      if (key === "path") { q.path = value; continue; }
      if (key === "method") { q.method = value; continue; }
      // Not a facet we know. It is probably what they are searching for.
      words.push(token);
      continue;
    }
    if ((LEVELS as string[]).includes(token.toLowerCase())) {
      q.minLevel = token.toLowerCase() as Level;
      continue;
    }
    words.push(token);
  }

  if (words.length) q.search = words.join(" ");
  return q;
}

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
export function toolsFor(slug: string, ownerId: string, cookie?: string): Handler {
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

        /**
         * The schema, before any query.
         *
         * This did not exist, and its absence was the single biggest thing wrong
         * with the `db` tool: an agent asked "how many users" had no way to learn
         * that the table is called `customers`. It either guessed — and reported
         * `relation "users" does not exist` as though that answered the question —
         * or wrote an `information_schema` query, which is a 1.2-second read it
         * had to know to write.
         *
         * One round trip for the shapes and one for the counts, from the same
         * functions the database viewer uses. The row counts and arrival times are
         * included because "did the data land" is most of what gets asked, and
         * answering it should not need a second call.
         */
        case "tables": {
          const pool = getTenantReadPool(dbNameForSlug(slug));
          const shapes = await allShapes(pool);
          if (shapes.length === 0) {
            return { ok: true, data: { tables: [], note: "this database has no tables yet" } };
          }
          const stats = new Map((await readStats(pool, shapes)).map((x) => [x.name, x]));
          return {
            ok: true,
            data: {
              tables: shapes.map((t) => ({
                name: t.name,
                columns: t.columns.map((c) => `${c.name} ${c.type}${c.nullable === false ? " not null" : ""}`),
                primaryKey: t.primaryKey,
                rows: stats.get(t.name)?.rows ?? null,
                lastWriteAt: stats.get(t.name)?.lastWriteAt ?? null,
                // Which column means "when this arrived", so a query about
                // recency does not sort by `expires_at` or `updated_at`.
                arrivalColumn: recencyColumn(t),
                orderedBy: describeOrdering(orderingFor(t)),
              })),
              note: "rows is exact; lastWriteAt is null when the table records no arrival time",
            },
          };
        }

        /**
         * The log, through the same reader the screen uses.
         *
         * A filter grammar rather than a line count, because "read me the last
         * sixty lines" is the wrong question when an app prints a thousand an
         * hour. `./logs error` narrows by level, `./logs source=edge` by stream,
         * and anything else is free text — so an agent asking "what broke" reads
         * the errors rather than reading everything and hoping.
         *
         * Same `Query`, same `readLogs`, so the agent and the screen cannot
         * disagree about what a filter means.
         */
        case "logs": {
          const q = parseAgentQuery(arg);
          const page = await readLogs(slug, q, { limit: 80 });
          if (page.rows.length === 0) {
            // "Nothing since" and "no logs" are different facts. A file tail has
            // no history, so an app that has printed nothing since we started
            // watching has no lines and is not broken.
            return {
              ok: true,
              data: {
                lines: [],
                note: `nothing matched since ${page.since} — an app that prints nothing has no lines, which is not the same as being broken`,
              },
            };
          }
          return {
            ok: true,
            data: {
              lines: page.rows.map((r) => ({
                at: r.at,
                level: r.level,
                source: r.source,
                ...(r.http ? { request: `${r.http.method} ${r.http.path} -> ${r.http.status} in ${r.http.ms}ms` } : {}),
                msg: r.msg,
              })),
              more: Boolean(page.cursor),
              note: "newest first. `./logs error` for errors only, `./logs source=edge` for requests, anything else is a search",
            },
          };
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
              // The app's ADDRESS, derived, not the url recorded on the deploy
              // row. That column holds whatever the pipeline wrote at the time,
              // and for a fleet app that is the node's raw IP — so this tool was
              // handing the agent `http://8.232.255.172` as the place to find the
              // app. Verified on z1b3k before the fix.
              address: appUrl(slug),
              recordedUrl: d.url ?? null,
              name: d.name ?? null,
              note: "address is where the app answers; recordedUrl is what the deploy wrote and may be an internal address. status is whether it finished; stage is only the last step that ran",
            },
          };
        }

        /**
         * What the app itself says, right now.
         *
         * Not the same question as `deploys` or `describe`. Cloud Run's `ready` is
         * its opinion of the revision — true as soon as the container answered a
         * startup probe once — and an app can clear that and refuse every real
         * request afterwards, which is what a Django DisallowedHost does. This
         * asks the app and reports the status it gave.
         */
        case "probe": {
          const { probe, cached, reason } = await probeApp(slug, ownerId);
          if (!probe) return { ok: false, error: reason ?? "the app could not be reached" };
          return { ok: true, data: { ...probe, cached: Boolean(cached) } };
        }

        /**
         * Every address, not just the one the dashboard shows.
         *
         * An app answers on its platform address AND on any domain attached to
         * it, and "why does my custom domain 404" was unanswerable — the agent
         * could not see that the domain existed, let alone that its certificate
         * was still being issued.
         */
        case "domains": {
          const domains = await listDomains(slug);
          return {
            ok: true,
            data: {
              platform: appUrl(slug),
              attached: domains.map((d) => ({
                hostname: d.hostname,
                status: d.status,
                // The reason, when there is one. A domain stuck on "pending" with
                // a detail saying the DNS record is missing is a different
                // problem from one whose certificate is still being issued.
                detail: d.detail,
                liveAt: d.liveAt,
              })),
              note: "a domain is only reachable once its status is live",
            },
          };
        }

        case "files": {
          const bucket = bucketForSlug(slug);
          try {
            const objects = await listBucketObjectsCached(bucket);
            const { rows, note } = trunc(objects);
            return { ok: true, data: { bucket, objects: rows, note } };
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            // "The specified bucket does not exist" is not a failure — most apps
            // never ask for storage, and reporting the ordinary case as an error
            // teaches the agent to describe a working app as broken. Anything
            // else IS a failure and says so, because "we could not look" and
            // "there is nothing there" are opposite answers.
            if (/does not exist|notFound|404/i.test(m)) {
              return { ok: true, data: { bucket: null, objects: [], note: "this app has no storage bucket" } };
            }
            return { ok: false, error: m };
          }
        }

        case "jobs": {
          const jobs = await listJobs(slug);
          if (jobs.length === 0) {
            return { ok: true, data: { jobs: [], note: "nothing is scheduled for this app" } };
          }
          return { ok: true, data: { jobs } };
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
