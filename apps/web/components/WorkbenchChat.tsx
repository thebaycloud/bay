"use client";

import { useState } from "react";
import { ArrowUpIcon, CircleDashedIcon, DatabaseIcon } from "lucide-react";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
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
 * Three parts still come from components/ai-elements because the base registry has
 * no equivalent: Reasoning (the collapsed thinking block), Tool (a call with its
 * input, output and status), and PromptInput (the composer).
 *
 * MessageScroller is what should be holding this transcript — it anchors turn
 * boundaries and preserves reader position while content streams, which is exactly
 * the hard part of a chat log. It cannot be installed here: it depends on
 * `@shadcn/react`, whose peers are `react >=19` and `@types/react >=19`, and this
 * app is React 18.3.1 on Next 14.2.15. That is a React 19 upgrade, not a component
 * install. Until then the transcript is a plain overflow container — it scrolls, but
 * it does not follow a live edge, which is a real gap once step 7 streams tokens.
 */

type Turn = { id: number; question: string };

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

  function ask() {
    const q = text.trim();
    if (!q) return;
    setTurns((t) => [...t, { id: t.length, question: q }]);
    setText("");
  }

  return (
    <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      <div className="min-h-0 overflow-y-auto p-4">
        {turns.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <DatabaseIcon className="size-5 text-ink-3" aria-hidden="true" />
            <p className="text-sub font-medium text-ink">Ask about {slug}</p>
            <p className="max-w-[34ch] text-micro text-ink-2">
              How many users, what broke, what the last ship did. A read-only agent
              reads your app&rsquo;s own data — it can look, and it cannot change
              anything.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {turns.map((turn) => (
              <MessageGroup key={turn.id}>
                {/* The surface is NOT a component — Message gives you the row and
                    the column, and you supply the bubble. `data-slot` is what
                    MessageContent's `*:data-slot:self-end` rule aligns when the
                    message is align=end, and `data-variant="ghost"` is what tells
                    the header and footer to drop their padding. Getting either
                    attribute wrong is why this looked unstyled the first time. */}
                <Message align="end">
                  <MessageContent>
                    <div
                      className="max-w-[85%] rounded-2xl bg-tile px-3.5 py-2 text-ink"
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
                      <Reasoning defaultOpen={false}>
                        <ReasoningTrigger>Thinking, once this is wired up</ReasoningTrigger>
                        <ReasoningContent>
                          Where the agent&rsquo;s own reasoning will appear, collapsed
                          by default — the same shape Codex already streams through
                          runAgent&rsquo;s normalised events.
                        </ReasoningContent>
                      </Reasoning>

                      <Tool defaultOpen={false}>
                        <ToolHeader type="tool-db" state="output-available" title="db" />
                        <ToolContent>
                          <ToolInput input={{ query: "select count(*) from users" }} />
                          <ToolOutput
                            output={
                              <span className="font-mono text-micro">
                                preview only — nothing was queried
                              </span>
                            }
                            errorText={undefined}
                          />
                        </ToolContent>
                      </Tool>

                      <MessageResponse>
                        {"Every figure in a real answer will come from a tool result like the one above, never from prose — so a number you can see is a number something actually read."}
                      </MessageResponse>
                    </div>
                    <MessageFooter>preview · nothing was read</MessageFooter>
                  </MessageContent>
                </Message>

                {/* A system note belongs in the thread as a marker, not dressed up as
                    an assistant turn. That distinction is the whole reason this
                    component exists. */}
                <Marker variant="border" role="status">
                  <MarkerIcon>
                    <CircleDashedIcon className="size-3.5" />
                  </MarkerIcon>
                  <MarkerContent>
                    Chat is not connected yet — the engine lands in step 7.
                  </MarkerContent>
                </Marker>
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
      <div className="border-t border-border p-3">
        <PromptInput
          className="rounded-3xl border-transparent bg-tile px-1 shadow-none focus-within:border-line"
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
                <PromptInputActionMenuTrigger className="size-8 shrink-0 rounded-full border border-line bg-white hover:bg-tile" />
                <PromptInputActionMenuContent>
                  {STARTERS.map((q) => (
                    <PromptInputActionMenuItem key={q} onClick={() => setText(q)}>
                      {q}
                    </PromptInputActionMenuItem>
                  ))}
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            {/* A filled circle, not the bare ↵ the default renders: the send
                affordance is the one thing in this rail that should look like a
                button you press. */}
            <PromptInputSubmit
              className="size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-tile disabled:text-ink-3"
              disabled={!text.trim()}
              status="ready"
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
