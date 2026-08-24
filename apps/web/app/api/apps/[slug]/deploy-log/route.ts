export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { getDeploy } from "@/lib/deploys";
import { readLatestRunLines } from "@/lib/deploy-events";
import { lastBuildLog } from "@/lib/app-logs";

/**
 * The account of one deploy, as a transcript.
 *
 * A build is a BOUNDED thing: it starts, it says what it did, it ends. You read
 * it top to bottom once and jump to the step that failed. That is why it is not a
 * row in the log list — an infinite stream you tail and search is a different
 * shape of question, and one screen cannot be both without being bad at both.
 *
 * Three sources, returned SEPARATELY and labelled rather than merged into one
 * ordered list. They cannot be merged honestly: the deploy row has one timestamp,
 * `deploy_events` has per-line times from the control plane's clock, and Cloud
 * Build's lines all carry the build's create time rather than their own. Sorting
 * those together produces an order that looks authoritative and is invented.
 *
 * So: what the pipeline decided, then what the build printed, each in its own
 * order, with the failure named at the top where it is the first thing read.
 */
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const deploy = await getDeploy(slug);
    // Both, in parallel: one is Postgres and the other shells out to gcloud twice,
    // and the slower one should not be waiting on the faster.
    const [narration, build] = await Promise.all([
      readLatestRunLines(slug, 400).catch(() => []),
      lastBuildLog(slug, 400).catch(() => []),
    ]);

    return Response.json({
      deploy: deploy
        ? {
            status: deploy.status,
            // `status` answers doneness; `stage` is the last step that RAN.
            // Reading stage for doneness is what left every finished app saying
            // "shipping" forever.
            stage: deploy.stage ?? null,
            error: deploy.error ?? null,
            name: deploy.name ?? null,
            at: deploy.finishedAt ?? deploy.updatedAt ?? null,
          }
        : null,
      narration,
      build: build.map((l) => ({ line: l.message, severity: l.severity })),
      // A build that is still WORKING has not failed. Treating "not SUCCESS" as
      // bad once painted forty lines of a healthy in-flight build red.
      failed: deploy?.status === "failed" || build.some((l) => l.severity === "ERROR"),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
