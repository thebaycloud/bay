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
    const [callerToken, appToken] = await Promise.all([
      identityToken(SHOT_SERVICE),
      // The app is sealed; the screenshotter needs a token for the app's own
      // audience to get in, the same way the deploy probe does.
      identityToken(new URL(runUrl).origin),
    ]);
    if (!callerToken) return;

    await fetch(`${SHOT_SERVICE}/shot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${callerToken}`,
      },
      body: JSON.stringify({ slug, runUrl, idToken: appToken }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    // Swallowed on purpose. See the note at the top of this file.
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
