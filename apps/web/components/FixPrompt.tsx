"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The error, turned into something to hand your coding agent.
 *
 * WHAT THIS IS NOT: it does not fix anything. `/api/apps/[slug]/fix` reads the
 * error, clones the repository when there is one, and writes a prompt — and the
 * prompt goes to the agent the person already works in. That is deliberate and it
 * is the honest division: we can see production and they cannot, they can change
 * the code and we should not.
 *
 * It lived in `IssuesPanel`, which had a Fix button per error and rendered the
 * prompt underneath — and it was ORPHANED when the Infra screen became Logs. The
 * commit that did it said "the errors it counted are now lines in the list",
 * which was true of the count and wrong about this: a log line shows you an
 * error, it does not hand you anything to do about it. That panel is deleted
 * now; this is the part of it that was load-bearing.
 *
 * So it is a component now rather than a panel, and it sits wherever an error is
 * already on screen: the deploy transcript, and the newest error in the log.
 */
export function FixPrompt({
  slug,
  error,
  /** When there is no error text to hand over, say why rather than offering a dead button. */
  absent,
}: {
  slug: string;
  error: string | null;
  absent?: string;
}) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const ask = useCallback(async () => {
    if (!error) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The WHOLE error. The line above it is cut to fit a row; a diagnosis made
        // from a truncated stack is a diagnosis of the wrong thing.
        body: JSON.stringify({ error }),
      });
      // The body is read as TEXT first, because a route that throws answers with
      // an HTML error page and `r.json()` on that throws — which landed in the
      // catch below and reported "Couldn't reach the server" about a server that
      // had answered, and answered with the reason. Two different failures were
      // wearing one message, and it was the wrong one.
      const raw = await r.text();
      type Body = { fixPrompt?: unknown; error?: unknown };
      let d: Body | null = null;
      try {
        d = JSON.parse(raw) as Body;
      } catch {
        d = null;
      }
      if (!d) {
        setErr(r.ok ? "That came back in a shape we could not read." : `The server failed on this (${r.status}).`);
      } else if (!r.ok || d.error) {
        setErr(String(d.error ?? `That did not work (${r.status}).`));
      } else if (typeof d.fixPrompt === "string" && d.fixPrompt.trim()) {
        setPrompt(d.fixPrompt);
      } else {
        setErr("Nothing came back to hand over.");
      }
    } catch {
      // Only a genuine network failure reaches here now: the fetch itself did not
      // complete. Everything the server said, however badly, is handled above.
      setErr("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }, [slug, error]);

  function copy() {
    if (!prompt) return;
    void navigator.clipboard?.writeText(prompt).then(() => setCopied(true));
  }

  if (!error) {
    return absent ? <p className="text-[13px] text-ink-3">{absent}</p> : null;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {prompt === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* Filled, not ghost. This is the one action on a screen somebody
              reached because something is broken, and it should look like it. */}
          <Button disabled={busy} onClick={() => void ask()} size="sm">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {busy ? "Reading the error" : "Write a fix prompt"}
          </Button>
          <span className="text-[12.5px] text-ink-3">for the agent you already use</span>
          {err ? <span className="text-[12.5px] text-red">{err}</span> : null}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={copy} size="sm">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy fix prompt"}
            </Button>
            <Button
              className="text-ink-2 hover:text-ink"
              onClick={() => { setPrompt(null); setCopied(false); }}
              size="sm"
              variant="ghost"
            >
              Ask again
            </Button>
          </div>
          {/* Shown, not only copyable. A prompt somebody cannot read before
              pasting it into their own repository is one they have to trust. */}
          <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-card p-3 font-mono text-[12.5px] leading-[1.65] text-ink-2">
            {prompt}
          </pre>
        </>
      )}
    </div>
  );
}
