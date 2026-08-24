"use client";

import { useEffect, useState } from "react";
import { Check, Copy, TriangleAlert, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Row, RowGroup } from "@/components/panel/atoms";

interface Err {
  message: string;
  time: string;
}

/**
 * What production actually threw, and the prompt that fixes it.
 *
 * Rebuilt on the panel's rows. It was `section reveal` / `issue-head` /
 * `prompt-box` and its own `toast` — classes from the injected drawer's
 * stylesheet, which this app never loads, so the whole screen rendered as
 * unstyled text and the toast was permanently invisible.
 *
 * The fix opens under the error it belongs to rather than replacing it: you
 * paste the prompt while still looking at what it is for.
 */
export function IssuesPanel({ slug }: { slug: string }) {
  const [errors, setErrors] = useState<Err[] | null>(null);
  const [err, setErr] = useState("");
  const [fixing, setFixing] = useState<number | null>(null);
  const [fix, setFix] = useState<{ i: number; prompt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/apps/${slug}/errors`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErr(d.error);
        setErrors(d.errors || []);
      })
      .catch((e) => {
        setErr(String(e));
        setErrors([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function getFix(i: number, message: string) {
    setFixing(i);
    setFix(null);
    setErr("");
    const r = await (
      await fetch(`/api/apps/${slug}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: message }),
      })
    ).json();
    setFixing(null);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setFix({ i, prompt: r.fixPrompt });
  }

  function copy(t: string) {
    navigator.clipboard?.writeText(t).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <RowGroup title="Issues">
      {errors === null && !err ? <Row sub="from your app’s production logs" title="Reading…" /> : null}

      {err ? <Row sub={err.slice(0, 140)} title="That could not be read" /> : null}

      {errors && errors.length === 0 && !err ? (
        <Row title="No errors" />
      ) : null}

      {errors?.map((e, i) => (
        <div key={i}>
          <Row icon={TriangleAlert} title={<span className="text-[14px]">{e.message}</span>}>
            <Button disabled={fixing === i} onClick={() => getFix(i, e.message)} size="sm" variant="outline">
              <Wand2 className="size-3.5" />
              {fixing === i ? "Reading it…" : "Get the fix"}
            </Button>
          </Row>

          {fix && fix.i === i ? (
            <div className="flex flex-col gap-2.5 border-b border-border bg-ground px-4 py-3.5 last:border-0">
              <pre className="max-h-[240px] max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.7] text-ink-2">
                {fix.prompt}
              </pre>
              <div className="flex items-center gap-3">
                <Button onClick={() => copy(fix.prompt)} size="sm">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy fix prompt"}
                </Button>
                <span className="text-[13px] text-ink-3">paste into your coding agent</span>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </RowGroup>
  );
}
