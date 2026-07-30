import { getAppBySlug } from "./apps";
import { ownsApp as ownsRunService } from "./gcloud";

/**
 * Does this user own this app?
 *
 * Postgres is the authority. The older check asked Cloud Run — it read the owner
 * label off the app's own service — which quietly meant "no" for every app that
 * has no service of its own. Static apps never get one: they are served by the
 * single shared static service, so `supersonic status`, `logs`, `env`, `exec`,
 * `diagnose` and the rest all answered "you don't own that app" to the person who
 * did. The same was true of an app mid-deploy, before its service exists.
 *
 * The Cloud Run label stays as a fallback for apps that predate the `apps` table.
 */
export async function ownsApp(slug: string, ownerId: string): Promise<boolean> {
  if (!ownerId) return false;
  try {
    const app = await getAppBySlug(slug);
    if (app) return app.owner_id === ownerId;
  } catch {
    // A database hiccup must not lock someone out of their own app — fall through
    // to the label, which is the weaker but independent answer.
  }
  return ownsRunService(slug, ownerId);
}
