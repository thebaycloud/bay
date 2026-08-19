"use client";

import { useState } from "react";
import { DatabaseIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";

/**
 * The chat rail.
 *
 * Built on components/ai-elements — the shadcn AI registry — rather than
 * hand-rolled bubbles, because the parts a real agent turn produces are exactly
 * the parts it ships: `Reasoning` is the collapsed thinking block, `Tool` is a
 * tool call with its input and output, `MessageResponse` renders markdown as it
 * streams, and `Conversation` is a stick-to-bottom scroller that stays pinned
 * while tokens arrive and lets go the moment you scroll up. Every one of those is
 * something I would otherwise have got subtly wrong.
 *
 * The engine is step 7. Until then a submit does NOT invent an answer: it echoes
 * the question and replies saying it is not connected, then renders one Reasoning
 * block and one Tool call so the vocabulary can be reviewed. Those two are
 * labelled as a preview in the copy itself, because a fake answer that reads like
 * a real one is the one thing this surface must never do.
 */

type Turn = { id: number; question: string };

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
      <Conversation className="min-h-0">
        <ConversationContent className="gap-4 p-4">
          {turns.length === 0 && (
            <ConversationEmptyState
              icon={<DatabaseIcon className="size-5 text-ink-3" />}
              title={`Ask about ${slug}`}
              description="How many users, what broke, what the last ship did. Answers come from a read-only agent reading your app's own data — it can look, and it cannot change anything."
            />
          )}

          {turns.map((turn) => (
            <div className="flex flex-col gap-3" key={turn.id}>
              <Message from="user">
                <MessageContent>{turn.question}</MessageContent>
              </Message>

              <Message from="assistant">
                <MessageContent>
                  <Reasoning defaultOpen={false}>
                    <ReasoningTrigger>Thinking, once this is wired up</ReasoningTrigger>
                    <ReasoningContent>
                      This is where the agent&rsquo;s thinking will appear, collapsed
                      by default and expandable — the same shape Codex already
                      streams through `runAgent`&rsquo;s normalised events.
                    </ReasoningContent>
                  </Reasoning>

                  <Tool defaultOpen={false}>
                    <ToolHeader type="tool-db" state="output-available" title="db" />
                    <ToolContent>
                      <ToolInput input={{ query: "select count(*) from users" }} />
                      <ToolOutput output={<span className="font-mono text-micro">preview only — nothing was queried</span>} errorText={undefined} />
                    </ToolContent>
                  </Tool>

                  <MessageResponse>
                    {"**Chat is not connected yet.** The rail above is the real UI — a collapsed thinking block and a tool call with its input and output — rendered from placeholder content so it can be reviewed before the engine exists.\n\nWhen it lands, every figure in an answer will come from a tool result like that one and never from prose, so a number you can see is a number something actually read."}
                  </MessageResponse>
                </MessageContent>
              </Message>
            </div>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput
        className="rounded-none border-0 border-t border-border shadow-none"
        onSubmit={(_message, event) => {
          event.preventDefault();
          ask();
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder={`Ask about ${slug}…`}
            value={text}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools />
          <PromptInputSubmit disabled={!text.trim()} status="ready" />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
