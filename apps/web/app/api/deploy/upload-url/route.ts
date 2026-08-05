export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a deploy's source bytes go now: straight to the bucket, not through here.
 *
 * Cloud Run caps a buffered request body at 32 MiB, and the cap is enforced by
 * the Google front end — the request never reaches this service. So a project
 * larger than that produced no log line, no handler invocation and no error
 * anywhere on the server; the app row simply stayed `reserved` and the CLI said
 * the deploy "ended without confirming it went live". Measured on excalidraw:
 * a 36.3 MB bundle, HTTP 413, nothing on the server side to see.
 *
 * This endpoint hands back a signed PUT URL scoped to ONE object. The client
 * encrypts the tarball, puts it there itself, and passes the object name and key
 * to /api/deploy instead of the bytes. A 50 MB upload through this path was
 * measured working; the GCS object limit is 5 TiB.
 *
 * No plan gate here on purpose. This mints a URL and nothing else — the deploy
 * it is for is still refused by /api/deploy and /api/deploy/reserve, which is
 * where entitlement lives and where refusing means something to the user.
 */
import { currentUserId } from "@/lib/session";
import { signedSourceUpload } from "@/lib/deploy-runs";

export async function POST() {
  const uid = await currentUserId();
  if (!uid) return Response.json({ error: "not signed in" }, { status: 401 });

  const upload = await signedSourceUpload();
  if (!upload) {
    // Deliberately not "fall back to sending the body". The body path is the one
    // that does not work for the sizes this exists for, and silently taking it
    // would reproduce the exact failure — a 413 the server never sees — with an
    // extra step in front of it.
    return Response.json(
      { error: "could not prepare an upload location — retry, and if it persists this is ours, not yours" },
      { status: 503 },
    );
  }
  return Response.json(upload);
}
