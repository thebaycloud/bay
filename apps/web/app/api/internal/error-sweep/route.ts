export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * "Your app is throwing errors in production."
 *
 * Every part of this already existed and nothing joined them up: log ingestion,
 * error detection, and a fix-prompt generator. What was missing was somebody
 * noticing on the user's behalf, so an app could sit crash-looping while the
 * platform knew and said nothing.
 *
 * WHY IT IS A SWEEP AND NOT A HOOK
 *
 * There is no point in the request path where "this app has started erroring" is
 * known. The errors are in Cloud Logging, written by the tenant's own process or
 * by the edge, and neither calls us. So something has to look, on a timer.
 *
 * ONE QUERY FOR EVERY APP — see `errorsByApp`. Asking per app would be an API
 * round trip per app per tick, which is how a well-meaning alert becomes the
 * platform's largest running cost.
 *
 * AUTHENTICATION
 *
 * A shared secret in a header, compared in constant time. This endpoint mails
 * users and reads every tenant's logs, so an unauthenticated one is both a
 * spam cannon and a cross-tenant read. It is not reachable from a session on
 * purpose: a person clicking it would be sending mail to other people.
 */
import { timingSafeEqual } from "node:crypto";
import { errorsByApp } from "@/lib/logs";
import { getAppBySlug } from "@/lib/apps";
import { getAccount } from "@/lib/users";
import { sendProductionErrors } from "@/lib/emails";

/** How long a tick looks back. Matches the intended schedule: hourly. */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * How many errors in the window before it is worth an email.
 *
 * Not one. A single stray exception is normal in anything with users, and an
 * alert that fires on it is an alert people filter to a folder within a week —
 * at which point the genuinely broken app is filtered too. Three in an hour is
 * the cheapest signal that something is actually wrong rather than merely
 * imperfect.
 */
const THRESHOLD = 3;

function authorised(req: Request): boolean {
  const expected = process.env.SWEEP_SECRET ?? "";
  // No secret configured means this endpoint is off, NOT open. An unset variable
  // has turned exactly this kind of endpoint into a public one before.
  if (!expected) return false;
  const got = req.headers.get("x-sweep-secret") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, which throws on a mismatch — and
  // comparing lengths first leaks only the length, which the header already has.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorised(req)) return new Response("not found", { status: 404 });

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  let bursts: Awaited<ReturnType<typeof errorsByApp>>;
  try {
    bursts = await errorsByApp(since);
  } catch (e) {
    // A failed READ is not "no errors" — the single most repeated bug in this
    // codebase. Report it as a failure so a broken sweep is visible rather than
    // looking like a quiet hour.
    console.error("error-sweep read failed:", e instanceof Error ? e.message : String(e));
    return Response.json({ error: "could not read logs" }, { status: 502 });
  }

  // The hour, as a key. Every app that errors in this hour gets at most one
  // email about it, and the NEXT hour is a new email — so a crash loop reports
  // hourly rather than once per error.
  const hourKey = since.slice(0, 13);

  let mailed = 0;
  const skipped: string[] = [];
  for (const b of bursts) {
    if (b.count < THRESHOLD) continue;
    try {
      const app = await getAppBySlug(b.slug);
      // An app we do not have a row for is not ours to mail about. This is the
      // arm that catches a Cloud Run service whose name happens to look like a
      // slug.
      if (!app?.owner_id) { skipped.push(b.slug); continue; }
      const account = await getAccount(app.owner_id);
      if (!account?.email) { skipped.push(b.slug); continue; }
      const r = await sendProductionErrors({
        userId: app.owner_id,
        email: account.email,
        slug: b.slug,
        count: b.count,
        sample: b.newest,
        hourKey,
      });
      if (r.ok && !r.skipped) mailed++;
    } catch (e) {
      console.error(`error-sweep ${b.slug}:`, e instanceof Error ? e.message : String(e));
      skipped.push(b.slug);
    }
  }

  return Response.json({
    ok: true,
    since,
    appsWithErrors: bursts.length,
    // Reported rather than silently dropped: a sweep that covers less than it
    // looks like it covers is worse than one that says so.
    overThreshold: bursts.filter((b) => b.count >= THRESHOLD).length,
    mailed,
    skipped,
  });
}
