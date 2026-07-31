import { getLogs, type LogLine } from "./gcloud";
import { getDeploy } from "./deploys";
import { appBuildTag } from "./build-config";
import { spawn } from "node:child_process";

const PROJECT = "supersonic-deploy-prod";
const REGION = "us-central1";

/**
 * `supersonic logs <app>` for an app that never got as far as running.
 *
 * getLogs reads Cloud Run revision logs for a service named after the slug,
 * which is the right answer for a running app and no answer at all for the two
 * cases where somebody is most likely to be asking. An app whose build failed
 * has no service, so the query matches nothing. A static app never has a service
 * of its own — one shared server fronts all of them — so it matches nothing
 * either, forever. Both returned "no logs in that window", which reads as "your
 * app is quiet" rather than "your app does not exist", and sends people looking
 * in the wrong place for a failure that was recorded somewhere else entirely.
 *
 * So when the running app has nothing to say, the deploy does: the recorded
 * failure reason first, then the build log of the deploy that produced it.
 */

function capture(args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("gcloud", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.on("error", () => { clearTimeout(kill); resolve(""); });
    p.on("close", () => { clearTimeout(kill); resolve(out); });
  });
}

/** The tail of this app's most recent Cloud Build, by the tag every deploy sets. */
async function lastBuildLog(slug: string, limit: number): Promise<LogLine[]> {
  const list = await capture([
    "builds", "list", "--region", REGION, "--project", PROJECT,
    "--filter", `tags=${appBuildTag(slug)}`, "--limit", "1",
    "--format=value(id,status,createTime)",
  ]);
  const [id, status, createTime] = list.trim().split("\n")[0]?.split("\t") ?? [];
  if (!id) return [];
  const raw = await capture(["beta", "builds", "log", id, "--region", REGION, "--project", PROJECT]);
  const lines = raw.split("\n")
    .map((l) => l.replace(/^Step #\d+ - "[^"]*":\s?/, "").replace(/\r/g, "").trimEnd())
    .filter((l) => l.trim());
  if (!lines.length) return [];
  return [
    { message: `— build ${id} (${status || "unknown"}) —`, time: createTime ?? "", severity: "NOTICE" },
    ...lines.slice(-limit).map((message) => ({
      message: message.slice(0, 600),
      time: createTime ?? "",
      // A failed build's output is the explanation; marking it ERROR is what puts
      // it in front of someone filtering for the problem.
      severity: status === "SUCCESS" ? "INFO" : "ERROR",
    })),
  ];
}

/**
 * Logs for an app, from wherever they actually are.
 *
 * The running app is always preferred: if it is up and talking, that is what
 * anyone asking for logs wants. The deploy record is consulted only when the
 * app has nothing — which is precisely the case the old answer got wrong.
 */
export async function appLogs(
  slug: string,
  opts: { limit?: number; severity?: string; freshness?: string } = {},
): Promise<LogLine[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const running = await getLogs(slug, opts).catch(() => [] as LogLine[]);
  if (running.length) return running;

  const deploy = await getDeploy(slug);
  const out: LogLine[] = [];
  if (deploy?.status === "failed" && deploy.error) {
    out.push({
      message: "— this app's last deploy failed —",
      time: deploy.finishedAt ?? deploy.updatedAt ?? "",
      severity: "NOTICE",
    });
    for (const line of deploy.error.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-limit)) {
      out.push({ message: line.slice(0, 600), time: deploy.finishedAt ?? "", severity: "ERROR" });
    }
  } else if (deploy?.status === "building") {
    out.push({
      message: `— ${slug} is still deploying${deploy.stage ? `: ${deploy.stage}` : ""} —`,
      time: deploy.updatedAt ?? "",
      severity: "NOTICE",
    });
  }

  // The build log, whether or not the deploy row explained itself: a build that
  // failed says far more than the one-line reason distilled from it, and a build
  // that succeeded is still the only trace of an app that has never been visited.
  const build = await lastBuildLog(slug, Math.max(limit - out.length, 10)).catch(() => [] as LogLine[]);
  return [...out, ...build];
}
