export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The confirmation link, clicked.
 *
 * A GET that redirects rather than a page that renders, because this is arrived
 * at from a mail client and has nothing to show: either the address is now
 * confirmed or the link is stale, and both are one line on a page the user
 * already has. The outcome rides in the query string so `/settings` can say it.
 *
 * GET WITH A SIDE EFFECT, DELIBERATELY
 *
 * Normally a GET that changes state is a mistake — a link preview or a scanner
 * fetches it and the effect happens without anybody clicking. Here that is
 * acceptable and in fact the desired semantics: the thing being proven is
 * control of the mailbox, and something fetching the link from inside that
 * mailbox is precisely the proof. The token is single-use, so a scanner burning
 * it costs the user one re-send and never grants anything.
 */
import { redirect } from "next/navigation";
import { redeemEmailVerification } from "@/lib/auth-tokens";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  let ok = false;
  try {
    ok = Boolean(await redeemEmailVerification(token));
  } catch (e) {
    console.error("verify-email:", e instanceof Error ? e.message : String(e));
  }
  redirect(`/settings?verified=${ok ? "1" : "0"}`);
}
