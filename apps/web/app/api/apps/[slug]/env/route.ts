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
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ keys: [], error: "forbidden" }, { status: 403 });
  try {
    // Shared with chat's `keys` tool, which used to call describeService alone and
    // therefore answered "no environment keys configured" about every fleet app.
    const { keys, note } = await envKeysFor(slug);
    // Not placed is not the same as having no variables, and answering `[]` to the
    // first would read as an app that simply has none.
    if (!keys) return Response.json({ keys: [], error: note });
    return Response.json({ keys });
  } catch (e) {
    return Response.json({ keys: [], error: e instanceof Error ? e.message : String(e) });
  }
}

// POST { set?: {K:V}, unset?: [K] } -> update env, new revision
async function postHandler(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) return Response.json({ error: "forbidden" }, { status: 403 });
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
    const svc = await describeService(slug);
    return Response.json({ ok: true, keys: svc.envKeys, note: "a new revision is rolling out" });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}


// Reachable from the app's own X-ray drawer, which runs on the app's own
// origin. See lib/cors.ts: only THAT origin is allowed, never every subdomain.
export const OPTIONS = optionsHandler;
export const GET = withCors(getHandler);
export const POST = withCors(postHandler);
