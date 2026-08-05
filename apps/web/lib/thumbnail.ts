import { accessToken } from "./gcp-rest";

/**
 * Asking the screenshot service for a picture of an app.
 *
 * Fire-and-forget by design. A thumbnail is decoration; a deploy that waited on
 * one — or failed because one failed — would be trading something that matters for
 * something that does not.
 */

const SHOT_SERVICE = process.env.SHOT_SERVICE_URL ?? "";
export const THUMBS_PREFIX = "_thumbs";

export function thumbnailObject(slug: string): string {
  return `${THUMBS_PREFIX}/${slug}.jpg`;
}

/**
 * Mint an identity token for a Cloud Run audience using the metadata server.
 *
 * The control plane runs on Cloud Run, so this is available in production and
 * absent locally — where the whole call is skipped anyway, because SHOT_SERVICE_URL
 * is unset.
 */
/**
 * Is this app's address a Cloud Run one?
 *
 * A copy of `isCloudRunTarget` in services/proxy/src/upstream.ts, because these
 * are separate deployables with no module in common. It is written to fail in
 * the opposite direction, deliberately: over there `false` selects the fleet's
 * edge secret, so a Cloud Run host that failed the check would send the wrong
 * credential to a tenant. Here `false` selects "mint nothing", so anything this
 * cannot parse is simply never handed a Google-signed token.
 */
export function isCloudRunUrl(u: string): boolean {
  try {
    const hostname = new URL(u).hostname.replace(/\.$/, "");
    return hostname === "run.app" || hostname.endsWith(".run.app");
  } catch {
    return false;
  }
}

async function identityToken(audience: string): Promise<string | null> {
  try {
    const r = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) },
    );
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return t || null;
  } catch {
    return null;
  }
}

/**
 * Request a screenshot. Resolves when the request has been *sent*, not when the
 * picture exists — the caller is a deploy, and it has better things to wait for.
 */
export async function requestThumbnail(slug: string, runUrl: string): Promise<void> {
  if (!SHOT_SERVICE || !runUrl) return;
  try {
    // The app token is minted for a Cloud Run audience or it is not minted.
    //
    // A fleet app's runUrl is the fleet load balancer — a bare IP, which is no
    // Google audience and verifies nothing. Minting an identity token for it is
    // the defect phase 0 fixed in forward.ts, still here because it fell
    // outside that spec's scope: it hands another service a Google-signed
    // credential in our service account's name, for an audience that will never
    // check it.
    //
    // What the node's router actually wants is `x-supersonic-edge`, which the
    // screenshot service has no way to send today. So a fleet app gets no
    // thumbnail — said out loud below rather than disguised as a token that
    // cannot work. The request is still made, because whether a fleet app
    // should be screenshotted at all is a decision for whoever gives the shot
    // service a way in.
    const appIsCloudRun = isCloudRunUrl(runUrl);
    const [callerToken, appToken] = await Promise.all([
      identityToken(SHOT_SERVICE),
      // The app is sealed; the screenshotter needs a token for the app's own
      // audience to get in, the same way the deploy probe does.
      appIsCloudRun ? identityToken(new URL(runUrl).origin) : Promise.resolve(null),
    ]);
    if (!appIsCloudRun) {
      console.log(`thumbnail ${slug}: fleet app — no app token minted; the shot service cannot sign for the node router yet`);
    }
    if (!callerToken) {
      console.warn(`thumbnail ${slug}: no caller token — is this running on Cloud Run?`);
      return;
    }

    const r = await fetch(`${SHOT_SERVICE}/shot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${callerToken}`,
      },
      body: JSON.stringify({ slug, runUrl, idToken: appToken }),
      signal: AbortSignal.timeout(45_000),
    });
    // The failure stays swallowed — see the note at the top of this file — but it is
    // not silent. Nothing else in the system notices a thumbnail that never arrived,
    // so this line is the only place a broken chain shows up.
    console.log(`thumbnail ${slug}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    console.warn(`thumbnail ${slug}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Read a stored thumbnail. Null when there isn't one. */
export async function readThumbnail(bucket: string, slug: string): Promise<Buffer | null> {
  try {
    const token = await accessToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(thumbnailObject(slug))}?alt=media`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}
