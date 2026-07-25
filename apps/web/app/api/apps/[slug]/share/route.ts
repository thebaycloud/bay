export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getAppBySlug, setVisibility, listGrants, addGrant, removeGrant, type Visibility } from "@/lib/apps";
import { currentUserId } from "@/lib/session";

const VISIBILITIES: Visibility[] = ["private", "shared", "workspace"];

async function ownedApp(slug: string) {
  const uid = await currentUserId();
  if (!uid) return null;
  const app = await getAppBySlug(slug);
  if (!app || app.owner_id !== uid) return null;
  return app;
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({ visibility: app.visibility, grants: await listGrants(slug) });
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const app = await ownedApp(slug);
  if (!app) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));

  if (body.visibility) {
    if (!VISIBILITIES.includes(body.visibility)) {
      return Response.json({ error: "invalid visibility" }, { status: 400 });
    }
    await setVisibility(slug, body.visibility);
  }
  if (body.addEmail) {
    const email = String(body.addEmail).trim().toLowerCase();
    // 254 is the maximum length of an address per RFC 5321; without a bound an
    // arbitrarily long string matches the regex and reaches the database.
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: "invalid email" }, { status: 400 });
    }
    await addGrant(slug, email);
  }
  if (body.removeEmail) await removeGrant(slug, String(body.removeEmail));

  const fresh = await getAppBySlug(slug);
  return Response.json({ visibility: fresh?.visibility, grants: await listGrants(slug) });
}
