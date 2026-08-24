"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Messages } from "@/lib/i18n";

/**
 * The prompt, in a dialog.
 *
 * Same panel as the dashboard's Ship new step (apps/web/components/ShipNew.tsx):
 * Radix Dialog, a 520px panel on the ground colour, the prompt in a mono block
 * that is itself the copy target, and a labelled button under it. Rebuilt on
 * this app's tokens rather than imported, because the dashboard's markup is
 * written against the shadcn colour contract (bg-background, border-border,
 * bg-primary) and none of those names exist here.
 *
 * The prompt block IS a button. Everyone's first instinct in front of a block of
 * text they were told to paste somewhere is to click it, and `cursor-copy` is the
 * one cursor that says what the click does before it happens. The button below
 * stays for anyone who reads the label instead of trying the block.
 *
 * Radix rather than hand-rolled markup: focus trapping, focus return, the body
 * scroll lock and aria-modal are the whole reason to use a dialog primitive, and
 * they are all easy to get subtly wrong.
 */

/** Whose marks sit beside the label. The same three the buttons stack. */
const AGENTS = [
  { name: "Claude Code", src: "/logos/claude.png" },
  { name: "Codex", src: "/logos/openai.png" },
  { name: "Cursor", src: "/logos/cursor.png" },
];

export function PromptDialog({
  open,
  onOpenChange,
  prompt,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: string;
  t: Messages;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(id);
  }, [copied]);

  // Nothing is copied yet each time it opens, so the button must not still be
  // saying so from last time.
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const copy = () => {
    navigator.clipboard
      ?.writeText(prompt)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50 data-[state=open]:animate-overlay-in" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[100] w-[calc(100vw-2rem)] max-w-[520px]",
            "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[12px]",
            "border border-line bg-ground shadow-[0_24px_60px_-16px_rgba(0,0,0,0.28)]",
            "data-[state=open]:animate-panel-in"
          )}
        >
          <div className="flex items-baseline gap-2 px-5 pb-4 pt-5">
            <Dialog.Title className="m-0 min-w-0 truncate font-sans text-[17px] font-[450] tracking-[-0.01em] text-ink">
              {t.onboard.label}
            </Dialog.Title>
          </div>

          {/* The prompt is the instructions, not a description of them, so there
              is nothing to describe. Named for screen readers and hidden. */}
          <Dialog.Description className="sr-only">{t.onboard.aria}</Dialog.Description>

          <div className="flex min-w-0 flex-col gap-2.5 px-5 pb-5">
            <div className="flex items-center gap-3">
              <span className="text-[14px] font-[450] text-ink">{t.copyPrompt.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2.5">
                {AGENTS.map((a) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={a.name}
                    src={a.src}
                    alt={a.name}
                    title={a.name}
                    width={18}
                    height={18}
                    className="size-[18px] object-contain opacity-80"
                  />
                ))}
              </span>
            </div>

            <button
              type="button"
              aria-label={t.copyPrompt.aria}
              onClick={copy}
              className={cn(
                "cursor-copy rounded-[8px] border border-line bg-white p-3.5 text-left transition-colors",
                "hover:border-ink-3 hover:bg-tile",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3"
              )}
            >
              {/* Wraps rather than scrolls: a copy target that hides what it
                  copies is one people verify by pasting somewhere first. */}
              <pre className="m-0 max-h-[220px] max-w-full overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.7] text-ink-2">
                {prompt}
              </pre>
            </button>

            <button
              type="button"
              onClick={copy}
              className={cn(
                "inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[8px]",
                "border border-line bg-white font-sans text-[15px] font-[450] tracking-[-0.01em]",
                "transition-colors hover:bg-tile",
                copied ? "text-live" : "text-ink"
              )}
            >
              {copied ? (
                <Check size={16} strokeWidth={2.4} />
              ) : (
                <Copy size={15} strokeWidth={2} />
              )}
              {copied ? t.copyPrompt.copied : t.copyPrompt.label}
            </button>
          </div>

          <Dialog.Close
            aria-label="Close"
            className="absolute right-4 top-[18px] rounded-[4px] text-ink-3 opacity-80 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3"
          >
            <X size={16} strokeWidth={2} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
