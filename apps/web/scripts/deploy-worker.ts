/**
 * The warm deploy worker: the same pipeline, on a machine that is already up.
 *
 * WHAT IT IS FOR, in one number. The Cloud Run Job costs ~118 s before the
 * pipeline's first line, and `job-launch` says ~116 s of that is Cloud Run
 * scheduling an execution and pulling the image — not anything this repository
 * controls. That is roughly half of a 238 s deploy spent starting a container to
 * run code that another container is already running. This service is that
 * container, kept warm, and the dispatch becomes one HTTP hop.
 *
 * It is the same image as the control plane and the Job, with a third command,
 * so the three can never disagree about what a deploy is. The pipeline itself
 * lives in lib/deploy-one.ts and is shared with the Job verbatim.
 *
 * ## Every refusal is safe
 *
 * `offerToWorker` treats anything that is not an explicit 202 as "declined" and
 * dispatches to the Job instead. So a worker that is busy, on the wrong commit,
 * unreachable, or simply absent costs a deploy its old 118 seconds and nothing
 * else. That property is why this can exist without a migration: turning it off
 * is clearing DEPLOY_WORKER_URL on the control plane.
 *
 * ## Why one at a time
 *
 * A deploy holds a clone, a build context and an agent session; two in one
 * container share a memory limit, and the failure mode of sharing it is one
 * customer's build killing another's. The Job exists precisely so that each
 * deploy owns its own memory, and this must not quietly give that up for
 * everyone at once. One deploy per instance keeps the guarantee, and the
 * overflow keeps the Job — which is the same answer as before, at the same
 * price as before, for the second concurrent deploy only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { deployOne } from "@/lib/deploy-one";

const PORT = Number(process.env.PORT || 8080);

/** The commit this container runs, set by cloudbuild.yaml alongside the image. */
const IMAGE_TAG = (process.env.IMAGE_TAG || "").trim();

/**
 * The one deploy in flight, or null.
 *
 * A module-level variable is the whole concurrency control, and it is enough
 * because Cloud Run gives this service `--concurrency=1` and one instance:
 * "busy" is a property of THIS container, and a second container would be a
 * second worker with its own slot, which is correct rather than a bug.
 */
let inFlight: string | null = null;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A run id and a tag. Anything larger is not this request, and reading it
    // would be reading whatever a caller decided to send.
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { runId?: unknown; imageTag?: unknown };
  try {
    body = (await readBody(req)) as typeof body;
  } catch {
    return json(res, 400, { error: "bad json" });
  }

  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const imageTag = typeof body.imageTag === "string" ? body.imageTag.trim() : "";
  if (!runId) return json(res, 400, { error: "runId is required" });

  // THE DRIFT GUARD. A worker left on the previous commit would run the previous
  // commit's pipeline for every deploy that reached it — silently, and for as
  // long as nobody looked. The dispatcher sends the tag IT runs; if they differ,
  // this refuses and the Job — which cloudbuild.yaml updates in the same build —
  // takes the deploy on the right code.
  //
  // An unset tag on either side refuses too. "I do not know which commit I am"
  // is not a reason to run a customer's deploy.
  if (!IMAGE_TAG || !imageTag) {
    return json(res, 409, { error: `refusing: untagged worker (${IMAGE_TAG || "unset"}) or dispatcher (${imageTag || "unset"})` });
  }
  if (IMAGE_TAG !== imageTag) {
    return json(res, 409, { error: `refusing: worker runs ${IMAGE_TAG}, dispatcher runs ${imageTag}` });
  }

  if (inFlight) return json(res, 429, { error: `busy with ${inFlight}` });

  // Claimed BEFORE the response, so two requests arriving together cannot both
  // be accepted. `deployOne` claims the run row as well, which is the durable
  // half; this is the one that stops this container starting two pipelines.
  inFlight = runId;
  json(res, 202, { accepted: runId });

  // Deliberately not awaited: the dispatcher is a person's deploy waiting on an
  // HTTP response, and the pipeline takes minutes. Cloud Run keeps this instance
  // alive because the request has been answered but the process is busy — which
  // is why `--no-cpu-throttling` is not optional for this service.
  void deployOne(runId)
    .then((r) => {
      if (r === "missing") console.error(`deploy-worker: run ${runId} is not on file — nothing to do`);
    })
    .catch((e) => console.error(`deploy-worker: run ${runId} threw on the way out`, e))
    .finally(() => { inFlight = null; });
}

const server = createServer((req, res) => {
  const url = (req.url || "").split("?")[0];

  // Answers while a deploy is in flight, and says so. A health check that went
  // quiet under load would make Cloud Run replace the instance mid-deploy.
  if (req.method === "GET" && (url === "/_healthz" || url === "/")) {
    return json(res, 200, { ok: true, imageTag: IMAGE_TAG || null, busy: inFlight !== null });
  }
  if (req.method === "POST" && url === "/run") {
    handleRun(req, res).catch((e) => {
      console.error("deploy-worker: /run failed", e);
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
    return;
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.error(`deploy-worker: listening on ${PORT}, image tag ${IMAGE_TAG || "(unset — every deploy will be refused)"}`);
});
