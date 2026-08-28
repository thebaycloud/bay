export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { forbiddenBody } from "@/lib/api-error";
import { getDeploy } from "@/lib/deploys";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { withCors, optionsHandler } from "@/lib/cors";

async function getHandler(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  // During a first-ever deploy there may be no Cloud Run service yet, so we can't
  // always check ownership via the service — fall back to the deploy row's owner.
  const row = await getDeploy(slug);
  if (!uid) return Response.json(forbiddenBody(), { status: 403 });
  const owns = await ownsApp(slug, uid).catch(() => false);
  if (!owns && !row) return Response.json({ deploy: null });
  return Response.json({ deploy: row });
}

// The panel reads this from inside the hosted app, which is a different origin,
// so the browser will not hand the body to it without these. Every other route
// the panel touches already had them; this one did not, because until now
// nothing cross-origin asked what had shipped. Same rule as the rest: exactly
// this app's own origin, never every subdomain. See lib/cors.ts.
export const OPTIONS = optionsHandler;
export const GET = withCors(getHandler);
