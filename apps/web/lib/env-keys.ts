import { describeService } from "@/lib/gcloud";
import { placementEnvKeys } from "@/lib/fleet";
import { deployTargetForApp } from "@/lib/deploy-target";

/**
 * An app's environment variable NAMES, on whichever runtime it is actually on.
 *
 * Extracted because there were two readers and only one of them was right. The
 * `/env` route branches on the deploy target — a fleet app has no Cloud Run service,
 * so its variables come from its placement — while chat's `keys` tool called
 * `describeService` alone. For a fleet app that returns nothing, so chat answered
 * "this app has no environment keys configured" about an app with five of them, and
 * the Dev screen sitting next to it listed all five.
 *
 * Values are never returned, on either path. Names are enough to answer "what does
 * this connect to", and a value read back is a secret leaving the system.
 *
 * `null` means "could not be determined", which is NOT the same as `[]`. Not placed
 * on a node is not the same as having no variables, and answering `[]` to the first
 * reads as the second — which is the bug this function exists to stop having twice.
 */
export async function envKeysFor(
  slug: string,
): Promise<{ keys: string[] | null; note?: string }> {
  const target = await deployTargetForApp(slug);
  if (target.kind === "fleet") {
    const keys = await placementEnvKeys(slug);
    if (!keys) return { keys: null, note: "this app is not placed on a node right now" };
    return { keys };
  }
  const svc = await describeService(slug);
  return { keys: svc.envKeys };
}
