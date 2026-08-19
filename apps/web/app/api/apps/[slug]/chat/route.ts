export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUserId } from "@/lib/session";
import { ownsApp } from "@/lib/ownership";
import { runAgent } from "@/lib/agents/harness";
import { backendFor, agentName, bareModel, CHAT_MODEL } from "@/lib/agents";
import { seedTools, serveTools } from "@/lib/chat/bridge";
import { buildPrompt, chatSpec, type Turn } from "@/lib/chat/run";
import { toolsFor } from "@/lib/chat/tools";
import { recordAgentRun } from "@/lib/agent-usage";
import type { AgentEvent } from "@/lib/agents/types";

/**
 * Chat: a real coding agent, reading a running app, answering in words.
 *
 * Same-origin with the page that calls it, so there is no CORS here and no
 * `credentials: "include"` on the other side.
 *
 * READ-ONLY, and enforced by construction rather than by instruction. The tools in
 * lib/chat/tools.ts contain no operation that changes anything, the run gets
 * `network: false`, and the workspace has no repo in it. An agent cannot misuse a
 * capability it was never handed.
 *
 * The prompt injection risk is real and worth naming: the agent reads rows an app's
 * own users wrote, so on an app with public signup a display name is
 * attacker-controlled text, and a model reading text cannot reliably separate data
 * from instruction. Read-only bounds the damage to reading. `network: false` bounds
 * it to this owner's own screen, because there is no channel out — which is why the
 * tool bridge is files and not a socket. See lib/chat/bridge.ts.
 */

const TIMEOUT = Number(process.env.CHAT_TIMEOUT_MS || 120_000);

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);
  const uid = await currentUserId();
  if (!uid || !(await ownsApp(slug, uid))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    question?: string;
    history?: Turn[];
  };
  const question = String(body.question ?? "").trim();
  if (!question) return Response.json({ error: "no question given" }, { status: 400 });

  const prompt = buildPrompt(question, (body.history ?? []) as Turn[]);
  // Forwarded to the two tools that read owner-only endpoints on the app's own
  // hostname. Ownership was established above; this is that same user's reading.
  const cookie = req.headers.get("cookie") ?? undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          /* the client hung up; the run is abandoned below */
        }
      };

      const ws = mkdtempSync(join(tmpdir(), "ss-chat-"));
      const started = Date.now();
      let bridge: { close: () => void } | null = null;

      try {
        const dir = seedTools(ws);
        bridge = serveTools(dir, toolsFor(slug, cookie));
        /**
         * What the workspace actually contains, said out loud.
         *
         * The first deployed run answered "the analytics tool listing (TOOLS.md)
         * couldn't be read", and there was nothing in the container to check that
         * against — because `log` was a no-op here, which threw away the only
         * diagnostic the harness produces. Reading a log instead of arguing from
         * inference is the one thing that has worked today.
         */
        console.log(
          JSON.stringify({
            ev: "chat-ws",
            slug,
            ws,
            files: readdirSync(ws).sort(),
            tools: statSync(join(ws, "TOOLS.md")).size,
          }),
        );

        const backend = backendFor(agentName());
        const spec = chatSpec({ ws, model: bareModel(CHAT_MODEL), prompt });

        const run = await runAgent({
          backend,
          spec,
          label: "chat",
          timeoutMs: TIMEOUT,
          // A question is not a repair. It reads a few things and answers; 25 calls
          // is generous, and a chat turn that has made 25 is not converging.
          maxCalls: Number(process.env.CHAT_MAX_CALLS || 25),
          repeatsAllowed: 3,
          // The rail renders EVENTS; this log is for the container. Both are needed:
          // one is what a person reads, the other is what is left behind when a run
          // fails somewhere the rail cannot show.
          log: (line: string) => console.log(JSON.stringify({ ev: "chat-log", slug, line })),
          onEvent: (e: AgentEvent) => {
            if (e.kind === "tool" && e.tool) {
              send("tool", { name: e.tool.name, detail: e.tool.detail });
            } else if (e.kind === "text" && e.text) {
              send("text", { text: e.text });
            } else if (e.kind === "usage" && e.usage) {
              send("usage", { total: e.usage.total });
            } else if (e.kind === "error" && e.error) {
              send("error", { error: e.error });
            }
          },
        });

        // Cost is visible from day one, beside deploy cost, which is the
        // prerequisite for deciding whether this needs a cap.
        await recordAgentRun({
          runId: null,
          slug,
          role: "chat",
          engine: agentName(),
          model: bareModel(CHAT_MODEL),
          tokens: run.tokens,
          steps: run.steps,
          durationMs: Date.now() - started,
          outcome: run.ended === "timeout" ? "timeout" : run.error ? "error" : "ok",
        });

        console.log(
          JSON.stringify({
            ev: "chat-done",
            slug,
            ended: run.ended,
            steps: run.steps,
            tokens: run.tokens.total,
            error: run.error,
          }),
        );
        send("done", {
          text: run.text.trim(),
          steps: run.steps,
          tokens: run.tokens.total,
          ended: run.ended,
          // A run killed for looping may still have answered before it wandered,
          // so the text is sent either way and the reason is stated.
          error: run.error,
        });
      } catch (e) {
        console.error(JSON.stringify({ ev: "chat-threw", slug, error: e instanceof Error ? e.stack : String(e) }));
        send("error", { error: e instanceof Error ? e.message : String(e) });
        send("done", { text: "", steps: 0, tokens: 0, ended: "spawn-failed", error: null });
      } finally {
        bridge?.close();
        try {
          rmSync(ws, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Cloud Run and any proxy in front of it will otherwise buffer the whole
      // stream and deliver it at the end, which turns a streamed answer into a
      // 20-second blank rail.
      "X-Accel-Buffering": "no",
    },
  });
}
