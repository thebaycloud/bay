export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { verifySignature, webhookConfigured, readPush } from "@/lib/github-webhook";
import { forgetInstallation } from "@/lib/github-connections";
import { shipPush } from "@/lib/github-deploy";

/**
 * Where GitHub tells us somebody pushed.
 *
 * ## The one security boundary
 *
 * This route is exempt from the cookie gate in `auth.config.ts`, beside
 * Stripe's. There is no session behind it and no second check further in, and
 * what sits behind it can clone a private repository, run a container and
 * deploy to a live address under our own service account. The HMAC is the whole
 * boundary — which is why the body is read as TEXT first and parsed second, and
 * why nothing above the signature check touches the database.
 *
 * ## Why almost everything answers 200
 *
 * A delivery that did nothing is not an error. GitHub sends a push for a tag,
 * for a branch being deleted, for repositories nobody connected, and for events
 * we did not ask for — and the *Advanced* tab on the App page shows the
 * response body for every one of them. `{"ignored": "no-app-follows-this-branch"}`
 * is the difference between diagnosing this in a minute and reading our logs
 * for an hour. A non-2xx would also make GitHub retry, which for "nobody cares
 * about this repository" means retrying forever.
 *
 * The exceptions are the two that are genuinely wrong: an unconfigured platform
 * (503) and a signature that does not verify (401).
 */

function ignored(reason: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ignored: reason, ...extra });
}

export async function POST(req: Request): Promise<Response> {
  if (!webhookConfigured()) {
    return Response.json({ error: "no GitHub webhook secret configured" }, { status: 503 });
  }

  // Before JSON.parse, always. Re-serialising the parsed object produces
  // different bytes and therefore a signature that can never match, for a body
  // that looks identical in every way a person would check.
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signed by us and unparseable is a contradiction, so it is dropped rather
    // than raised: retrying will not fix it and there is nothing to act on.
    return ignored("unparseable-body");
  }

  const event = req.headers.get("x-github-event") ?? "";

  if (event === "ping") return Response.json({ ok: true });

  if (event === "installation") {
    const action = String((payload as { action?: unknown }).action ?? "");
    const id = Number((payload as { installation?: { id?: unknown } }).installation?.id);
    if (action === "deleted" && Number.isInteger(id)) {
      await forgetInstallation(id);
      return Response.json({ ok: true, forgot: id });
    }
    return ignored(`installation.${action || "unknown"}`);
  }

  // The set of repositories an installation can see changed. Nothing to store:
  // the picker reads that set live from GitHub for exactly this reason — a
  // mirror would be a second answer, wrong precisely when somebody is staring
  // at the list wondering where their new repository is.
  if (event === "installation_repositories") return ignored("installation_repositories");

  if (event !== "push") return ignored(`unhandled-event:${event || "none"}`);

  const read = readPush(payload);
  if (!read.ok) return ignored(read.reason);

  const result = await shipPush(read.push);
  if (!result.shipped) return ignored(result.reason, result.slug ? { slug: result.slug } : {});
  return Response.json({ ok: true, slug: result.slug, runId: result.runId, sha: read.push.sha });
}
