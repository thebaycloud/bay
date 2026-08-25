export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An app's environment, on whichever runtime it is actually on.
 *
 * This used to be `gcloud run services update` and nothing else, which for an
 * app on a node is wrong in one of two ways. A fleet-native app has no Cloud Run
 * service and the command fails. An app that MIGRATED to the fleet still has its
 * old service, because nothing deletes it — so the command SUCCEEDS, writes a
 * revision nothing routes to, reports success, and changes nothing about the
 * running app. The second is much worse than the first, and with
 * FLEET_PLACEMENT=1 every new app now lands where it applies.
 */
import { forbiddenBody } from "@/lib/api-error";
import { describeService, setEnv } from "@/lib/gcloud";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { setPlacementEnv } from "@/lib/fleet";
import { deployTargetForApp } from "@/lib/deploy-target";
import { envKeysFor } from "@/lib/env-keys";
import { withCors, optionsHandler } from "@/lib/cors";

// GET  -> list env var KEYS (values are never exposed)
async function getHandler(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ keys: [], ...forbiddenBody() }, { status: 403 });
  try {
    // Shared with chat's `keys` tool, which used to call describeService alone and
    // therefore answered "no environment keys configured" about every fleet app.
    const { keys, note } = await envKeysFor(slug);
    // Not placed is not the same as having no variables, and answering `[]` to the
    // first would read as an app that simply has none.
    //
    // `note`, NOT `error`. The CLI prints any `error` field it receives, prefixed
    // with `!`, so returning an explanation here made every `bay env` on an
    // unplaced app look like a failure — and a deploy report recorded exactly
    // that: `bay env` saying "no env vars set" for an app that had been told it
    // was carrying one.
    if (!keys) return Response.json({ keys: [], note });
    return Response.json({ keys });
  } catch (e) {
    // NOT the raw message. `envKeysFor` reaches `describeService`, which shells
    // out to `gcloud run services describe` and fails with
    // `ERROR: (gcloud.run.services.describe) Cannot find service [slug]` for
    // every app on a fleet node — which is every new app. The CLI printed that
    // verbatim on every successful ship, so a green deploy ended with a Google
    // Cloud stack trace that read like a failure.
    //
    // The fourth place this same mistake has been found. `envKeysFor` exists
    // because of the first.
    const raw = e instanceof Error ? e.message : String(e);
    const ours = /gcloud|Cannot find service/i.test(raw);
    return Response.json({
      keys: [],
      note: ours
        ? "we could not read this app's environment just now"
        : raw.slice(0, 200),
    });
  }
}

// POST { set?: {K:V}, unset?: [K] } -> update env, new revision
async function postHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json(forbiddenBody(), { status: 403 });
  const { set = {}, unset = [] } = await req.json().catch(() => ({}));
  try {
    const target = await deployTargetForApp(slug);
    if (target.kind === "fleet") {
      const keys = await setPlacementEnv(slug, set as Record<string, string>, unset as string[]);
      if (!keys) {
        return Response.json(
          { error: "this app is on a node but has no placement right now — redeploy it, then set the variable" },
          { status: 409 },
        );
      }
      // The node picks this up on its next pull and restarts the process, because
      // a changed environment is now a reason to restart. It was not, and that is
      // what would have made this a no-op on this runtime even once the spec was
      // being written correctly.
      return Response.json({ ok: true, keys, note: "the node applies this within about ten seconds" });
    }
    await setEnv(slug, set as Record<string, string>, unset as string[]);
    // Guarded even here, where the runtime branch above has already established
    // there IS a Cloud Run service. The write succeeded; reading the new key list
    // back is a courtesy, and failing the whole call over the courtesy would
    // report a successful `env set` as an error.
    const svc = await describeService(slug).catch(() => null);
    return Response.json({
      ok: true,
      keys: svc?.envKeys ?? Object.keys(set),
      note: "a new revision is rolling out",
    });
  } catch (e) {
    // Not the raw message: `setEnv` shells out to gcloud too, and a failed
    // `env set` should say what happened rather than paste a Google Cloud stack
    // trace into somebody's terminal.
    const raw = e instanceof Error ? e.message : String(e);
    return Response.json(
      {
        error: /gcloud|Cannot find service/i.test(raw)
          ? "we could not apply that to this app just now"
          : raw.slice(0, 200),
      },
      { status: 500 },
    );
  }
}


// Reachable from the app's own X-ray drawer, which runs on the app's own
// origin. See lib/cors.ts: only THAT origin is allowed, never every subdomain.
export const OPTIONS = optionsHandler;
export const GET = withCors(getHandler);
export const POST = withCors(postHandler);
