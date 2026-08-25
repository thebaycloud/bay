"use client";

import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FixPrompt } from "@/components/FixPrompt";

/**
 * What the last deploy did, as a transcript.
 *
 * A build is a BOUNDED thing — it starts, says what it did, ends — and you read it
 * top to bottom once, jumping to the step that failed. That is a different shape
 * of question from the log list next door, which is an infinite stream you tail
 * and search, and one screen cannot be both without being bad at both.
 *
 * THE FAILURE IS AT THE TOP, before either transcript. "Why did my deploy fail" is
 * the most-asked question about a deploy, and the answer was previously the last
 * line of a scroll — reachable only by reading everything that went right first.
 *
 * The two transcripts are kept APART rather than merged into one ordered list.
 * They cannot be merged honestly: `deploy_events` carries per-line times from the
 * control plane's clock, while Cloud Build's lines all carry the build's create
 * time rather than their own. Interleaving them by timestamp produces an order
 * that looks authoritative and is invented.
 */

interface Transcript {
  deploy: { status: string; stage: string | null; error: string | null; name: string | null; at: string | null } | null;
  narration: { line: string; at: string }[];
  build: { line: string; severity: string }[];
  failed: boolean;
  error?: string;
}

export function DeployLog({
  slug,
  /** The failure as the app list knows it, so the prompt can be asked for before
   *  the transcript has finished loading. */
  error: known,
}: {
  slug: string;
  error?: string | null;
}) {
  const [t, setT] = useState<Transcript | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    fetch(`/api/apps/${encodeURIComponent(slug)}/deploy-log`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) setErr(String(d.error));
        else { setErr(null); setT(d); }
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [slug, nonce]);

  if (err) return <Empty>That could not be read. {err.slice(0, 160)}</Empty>;

  if (!t) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton className="h-3" key={i} style={{ width: `${[62, 88, 45, 70][i]}%` }} />
        ))}
      </div>
    );
  }

  const d = t.deploy;
  const building = d?.status === "building" || d?.status === "pending" || d?.status === "deploying";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        {building ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-ink-3" />
        ) : t.failed ? (
          <CircleAlert className="size-4 shrink-0 text-red" />
        ) : (
          <CircleCheck className="size-4 shrink-0 text-[var(--green)]" />
        )}
        <span className="text-[15px] text-ink">
          {building ? "Shipping" : t.failed ? "The last ship failed" : "The last ship worked"}
        </span>
        {/* `stage` is the last step that RAN, never whether it finished — reading
            it for doneness is what left every finished app saying "shipping". */}
        {d?.stage ? <span className="truncate text-[13px] text-ink-3">{d.stage}</span> : null}
        <Button
          aria-label="Read this again"
          className="ml-auto size-7 shrink-0 text-ink-3 hover:text-ink"
          disabled={busy}
          onClick={() => setNonce((n) => n + 1)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* First, because it is the answer. */}
      {d?.error ? (
        <pre className="overflow-x-auto rounded-xl border border-red/30 bg-red/5 p-3 font-mono text-[12px] leading-[1.55] text-ink">
          {d.error}
        </pre>
      ) : null}

      {t.narration.length > 0 ? (
        <Section title="What the pipeline decided">
          {t.narration.map((l, i) => (
            <Line key={`n${i}`} bad={l.line.startsWith("✕")} text={l.line} />
          ))}
        </Section>
      ) : null}

      {t.build.length > 0 ? (
        <Section title="What the build printed">
          {t.build.map((l, i) => (
            <Line key={`b${i}`} bad={l.severity === "ERROR"} text={l.line} />
          ))}
        </Section>
      ) : null}

      {t.narration.length === 0 && t.build.length === 0 && !d?.error ? (
        <Empty>
          {d
            ? "Nothing was recorded for this ship."
            : "No ship on file for this app yet."}
        </Empty>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-0.5 text-[13px] text-ink-2">{title}</h3>
      <div className="max-h-[420px] overflow-auto rounded-xl border border-border font-mono text-[12px] leading-[1.6]">
        {children}
      </div>
    </section>
  );
}

/** A failing line keeps its colour; everything else is quiet, so red still means
 *  something when it appears. */
function Line({ text, bad }: { text: string; bad: boolean }) {
  return (
    <div
      className={`whitespace-pre-wrap break-words px-3 py-[1px] ${
        bad ? "bg-red/5 text-red" : "text-ink-2"
      }`}
    >
      {text || " "}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5 text-[14px] text-ink-2">
      {children}
    </div>
  );
}
