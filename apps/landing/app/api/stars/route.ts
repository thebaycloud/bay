import { GITHUB_REPO } from "@/lib/brand";

/**
 * The star count, fetched once an hour for everyone rather than once per visitor.
 *
 * Unauthenticated GitHub allows 60 requests an hour PER IP. Fetched from the
 * browser that is 60 per visitor's network, which is fine until a page gets
 * shared somewhere busy and everyone behind one NAT starts seeing nothing. Read
 * here instead, cached, so GitHub sees one request an hour from the server.
 *
 * Failure returns null rather than 0. A count of zero is a claim; no count is the
 * truth when we could not reach GitHub, and the pill renders without a number.
 */
export const revalidate = 3600;

export async function GET() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { stargazers_count?: number };
    const stars = typeof data.stargazers_count === "number" ? data.stargazers_count : null;
    return Response.json({ stars }, { headers: { "cache-control": "public, s-maxage=3600" } });
  } catch {
    return Response.json({ stars: null }, { headers: { "cache-control": "public, s-maxage=60" } });
  }
}
