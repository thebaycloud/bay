"use client";

import { useState } from "react";
import { ArrowUpIcon, CircleDashedIcon } from "lucide-react";
import { BayMark } from "@/components/BayMark";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";

/**
 * The chat rail, on shadcn's conversation primitives.
 *
 * `Message` / `MessageGroup` / `MessageHeader` / `MessageFooter` come from the
 * shadcn registry and own the whole conversation layout — alignment by `align`,
 * consecutive turns stacked by MessageGroup, header and footer slots that collapse
 * correctly on a ghost surface. `Marker` is the inline system note, which is what
 * "chat is not connected" actually is: a status row in the thread, not a fake
 * assistant message dressed up as one.
 *
 * Two parts still come from components/ai-elements because the base registry has no
 * equivalent: Tool (a call with its input and status) and PromptInput (the composer).
 *
 * There is no thinking block, and that is a seam limitation rather than a choice.
 * `AgentEvent` carries four kinds — tool, text, usage, error — so a model's reasoning
 * never reaches this side to be rendered. Showing one would mean adding a `reasoning`
 * kind at the seam and having both backends emit it, which is a change to the
 * contract two deploy paths depend on, not a change to this component.
 *
 * MessageScroller is what should be holding this transcript — it anchors turn
 * boundaries and preserves reader position while content streams, which is exactly
 * the hard part of a chat log. It cannot be installed here: it depends on
 * `@shadcn/react`, whose peers are `react >=19` and `@types/react >=19`, and this
 * app is React 18.3.1 on Next 14.2.15. That is a React 19 upgrade, not a component
 * install. Until then the transcript is a plain overflow container — it scrolls, but
 * it does not follow a live edge, which is a real gap once step 7 streams tokens.
 */

type Tool = {
  name: string;
  detail: string;
  /** Null until the call ends. Undefined when the backend reports no code. */
  exitCode?: number | null;
  output?: string;
  done?: boolean;
};

/**
 * What to call a tool call in the rail.
 *
 * Codex reports every one of these as `bash`, with the command as the detail — so
 * three reads in a row all rendered as "bash" and the rail said nothing about what
 * was being read. The tool is the FIRST WORD of the command, which for our seeded
 * scripts is `./db` or `./keys`. Falls back to the backend's own name for anything
 * that is not one of ours.
 */
/** A call that ended badly. Opened by default, because it is the answer. */
function failed(t: Tool): boolean {
  return t.done === true && t.exitCode !== null && t.exitCode !== undefined && t.exitCode !== 0;
}

function toolLabel(t: Tool): string {
  const first = t.detail.trim().split(/\s+/)[0] ?? "";
  const m = /^\.\/(\w+)$/.exec(first);
  return m ? m[1] : t.name;
}
type Turn = {
  id: number;
  question: string;
  /** Tool calls as they land, so the rail shows work rather than a spinner. */
  tools: Tool[];
  /** Streamed prose. Empty until the agent says something. */
  text: string;
  tokens: number;
  /** Set when the run failed or was cut short. Rendered as a marker, not prose. */
  note: string | null;
  running: boolean;
};

/** What the `+` offers. Every one of these is answerable from a read-only tool. */
const STARTERS = [
  "How many users signed up this week?",
  "What has been failing, and for how long?",
  "What did the last deploy change?",
  "Which keys is this app using?",
  "Who has access to this app?",
];

export function WorkbenchChat({ slug }: { slug: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const busy = turns.some((t) => t.running);

  /**
   * Ask, and stream the answer.
   *
   * The transcript is sent with the question so a follow-up has context; the route
   * caps how many turns it replays, because an uncapped thread is an unbounded bill.
   */
  async function ask() {
    const q = text.trim();
    if (!q || busy) return;
    const id = turns.length;
    const history = turns.map((t) => [
      { role: "you" as const, text: t.question },
      { role: "agent" as const, text: t.text },
    ]).flat().filter((m) => m.text);

    setTurns((t) => [...t, { id, question: q, tools: [], text: "", tokens: 0, note: null, running: true }]);
    setText("");

    const patch = (f: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t) => (t.id === id ? f(t) : t)));

    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      if (!res.ok || !res.body) {
        patch((t) => ({ ...t, running: false, note: `The request failed (${res.status}).` }));
        return;
      }

      // SSE parsed by hand rather than with EventSource: EventSource cannot POST,
      // and the question has to go in a body.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = /^event: (.+)$/m.exec(frame)?.[1];
          const raw = /^data: (.*)$/m.exec(frame)?.[1];
          if (!ev || !raw) continue;
          let data: any;
          try {
            data = JSON.parse(raw);
          } catch {
            continue;
          }
          if (ev === "tool") {
            patch((t) => ({ ...t, tools: [...t.tools, { name: data.name, detail: data.detail }] }));
          } else if (ev === "result") {
            // Attaches to the most recent unfinished call. Codex reports one result
            // per call in order, so the open one is always the last.
            patch((t) => {
              const tools = [...t.tools];
              for (let i = tools.length - 1; i >= 0; i--) {
                if (!tools[i].done) {
                  tools[i] = { ...tools[i], done: true, exitCode: data.exitCode, output: data.output };
                  break;
                }
              }
              return { ...t, tools };
            });
          } else if (ev === "text") {
            patch((t) => ({ ...t, text: t.text + data.text }));
          } else if (ev === "usage") {
            patch((t) => ({ ...t, tokens: data.total }));
          } else if (ev === "error") {
            patch((t) => ({ ...t, note: String(data.error) }));
          } else if (ev === "done") {
            patch((t) => ({
              ...t,
              running: false,
              text: data.text || t.text,
              tokens: data.tokens || t.tokens,
              note:
                t.note ??
                (data.ended === "timeout"
                  ? "It ran out of time before finishing."
                  : data.ended === "looping"
                    ? "It was stopped for going in circles — anything above is still what it read."
                    : data.ended === "spawn-failed"
                      ? "The agent could not start."
                      : null),
            }));
          }
        }
      }
      patch((t) => ({ ...t, running: false }));
    } catch (e) {
      patch((t) => ({ ...t, running: false, note: e instanceof Error ? e.message : String(e) }));
    }
  }

  return (
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      <div className="min-h-0 overflow-y-auto p-4">
        {turns.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 py-10 text-center">
            {/* The mark, not a database icon: this is the app's own front door,
                and a cylinder said the conversation was about a database. */}
            <BayMark className="size-9 text-ink-3" />
            <p className="text-sub font-medium text-ink">Ask about {slug}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {turns.map((turn) => (
              <MessageGroup key={turn.id}>
                {/* The surface is NOT a component — Message gives you the row and
                    the column, and you supply the bubble. `data-slot` is what
                    MessageContent's `*:data-slot:self-end` rule aligns when the
                    message is align=end, and `data-variant="ghost"` is what tells
                    the header and footer to drop their padding. */}
                <Message align="end">
                  <MessageContent>
                    <div
                      className="max-w-[85%] rounded-lg bg-tile px-3.5 py-2 text-ink"
                      data-slot="message-surface"
                    >
                      {turn.question}
                    </div>
                  </MessageContent>
                </Message>

                <Message align="start">
                  <MessageContent>
                    <MessageHeader>agent</MessageHeader>
                    <div
                      className="flex flex-col gap-2.5"
                      data-slot="message-surface"
                      data-variant="ghost"
                    >
                      {/* Every read it made, in order. This is the whole answer to
                          latency: a real agent run takes seconds, and a rail that
                          shows what it is reading is working rather than hung. */}
                      {turn.tools.map((tool, i) => (
                        <Tool defaultOpen={failed(tool)} key={`${tool.name}-${i}`}>
                          {/* The state is OBSERVED now. It used to be asserted:
                              every finished call rendered "Completed" because the
                              only event that reached here was the call itself, so a
                              tool that could not run looked identical to one that
                              answered. That is how five broken tools looked fine. */}
                          <ToolHeader
                            state={
                              !tool.done
                                ? "input-available"
                                : failed(tool)
                                  ? "output-error"
                                  : "output-available"
                            }
                            title={toolLabel(tool)}
                            type={`tool-${toolLabel(tool)}` as `tool-${string}`}
                          />
                          <ToolContent>
                            <ToolInput input={{ ran: tool.detail || "(no argument)" }} />
                            {tool.done ? (
                              <ToolOutput
                                errorText={failed(tool) ? `exited ${tool.exitCode}` : undefined}
                                output={
                                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-micro text-ink-2">
                                    {tool.output?.trim() || "(no output)"}
                                  </pre>
                                }
                              />
                            ) : null}
                          </ToolContent>
                        </Tool>
                      ))}

                      {turn.text ? (
                        <MessageResponse>{turn.text}</MessageResponse>
                      ) : turn.running ? (
                        <span className="text-sub text-ink-2">Reading your app…</span>
                      ) : null}
                    </div>
                    {turn.tokens ? (
                      <MessageFooter>{turn.tokens.toLocaleString()} tokens</MessageFooter>
                    ) : null}
                  </MessageContent>
                </Message>

                {/* A failure is a status row in the thread, not an assistant turn
                    pretending to be an answer. */}
                {turn.note ? (
                  <Marker role="status" variant="border">
                    <MarkerIcon>
                      <CircleDashedIcon className="size-3.5" />
                    </MarkerIcon>
                    <MarkerContent>{turn.note}</MarkerContent>
                  </Marker>
                ) : null}
              </MessageGroup>
            ))}
          </div>
        )}
      </div>

      {/* The composer, composed the way the registry intends it.
          It was previously handed `rounded-none border-0 shadow-none`, which
          stripped the card it draws for itself, and an empty PromptInputTools,
          which is why there was no `+`. The submit also defaults to a bare ↵
          glyph — the filled round button is a variant, not the default. */}
      <div className="p-3">
        <PromptInput
          // The radius and the fill have to land on the SAME element as the
          // border. PromptInput's className goes on the <form>; the border lives
          // on the InputGroup inside it, at its own rounded-md. Styling the form
          // gave a 24px grey fill inside a 14px border — two different shapes,
          // one control. Everything visual is therefore addressed at the
          // input-group itself.
          // rounded-xl, matching a card. 24px was a chat-app radius on a screen
          // whose every other surface is 12, and it is what made the rail read as
          // a different product from the list this app is opened from.
          className="[&_[data-slot=input-group]]:rounded-xl [&_[data-slot=input-group]]:border-transparent [&_[data-slot=input-group]]:bg-tile [&_[data-slot=input-group]]:shadow-none"
          onSubmit={(_message, event) => {
            event.preventDefault();
            ask();
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea
              className="bg-transparent"
              onChange={(e) => setText(e.currentTarget.value)}
              placeholder={`Ask about ${slug}…`}
              value={text}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              {/* The `+` opens starter questions, not attachments. A read-only
                  agent has nothing to do with an uploaded file, and a `+` that
                  opened an empty file dialog would be the dead control this
                  codebase keeps refusing to ship. */}
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger className="size-8 shrink-0 rounded-md border border-line bg-white hover:bg-tile" />
                <PromptInputActionMenuContent>
                  {STARTERS.map((q) => (
                    <PromptInputActionMenuItem key={q} onClick={() => setText(q)}>
                      {q}
                    </PromptInputActionMenuItem>
                  ))}
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            {/* Filled, not the bare ↵ the default renders: the send affordance is
                the one thing in this rail that should look like a button you
                press. Square-cornered like every other button here — it was a
                circle, which is a different product's grammar. */}
            <PromptInputSubmit
              className="size-8 shrink-0 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-white disabled:text-ink-3 disabled:opacity-100"
              disabled={!text.trim() || busy}
              status={busy ? "streaming" : "ready"}
              variant="default"
            >
              <ArrowUpIcon className="size-4" />
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
