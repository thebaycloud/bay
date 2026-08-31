"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Copy, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TopBar } from "@/components/TopBar";
import { Row, RowList } from "@/components/panel/atoms";
import { RowSkeleton } from "@/components/Skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Authorizing the CLI, on the product's own design system.
 *
 * It was 90 lines of inline `style={{}}` — a monospace column with hand-written
 * borders, its own button colours and a mid-page `1px solid var(--line)`
 * constant. Rows, groups and shadcn buttons now, so it reads as the same product
 * as the page it hands you back to.
 *
 * `position: relative; z-index: 1` was there to lift the content above the fixed
 * graph-paper grid the old stylesheet painted at `body::before`. That grid is
 * gone with the sidebar, so the lift is gone too.
 */

interface Tok {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}
interface Acct {
  email: string;
  name: string | null;
}

function shortDate(s: string | null): string {
  if (!s) return "never";
  try {
    return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function CliAuth() {
  const sp = useSearchParams();
  const port = sp.get("port");
  const name = sp.get("name") || "cli";
  // What the terminal says brought them here — the user's own request, quoted by
  // their agent. Shown below before anything is authorized, because this is a
  // fragment of what somebody typed to their assistant and it is about to be
  // sent to us: the one screen where a human is present is the one place that
  // can honestly be disclosed.
  const via = sp.get("via") || "";
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");

  // Who this authorization would attach to, and what is already attached. The
  // page used to say neither: you pressed Authorize and a token appeared, with
  // no way to see that the last four machines still hold one — or that you are
  // signed in as the wrong account.
  const [acct, setAcct] = useState<Acct | null>(null);
  const [tokens, setTokens] = useState<Tok[] | null>(null);
  const [freshId, setFreshId] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    try {
      const r = await fetch("/api/cli/token");
      const d = await r.json();
      setTokens(d.tokens ?? []);
    } catch {
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    fetch("/api/account")
      .then((r) => r.json())
      .then((d) => {
        if (d.email) setAcct(d);
      })
      .catch(() => {});
    loadTokens();
  }, [loadTokens]);

  async function authorize() {
    setState("working");
    setMsg("");
    try {
      const r = await fetch("/api/cli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The CLI sends `os.hostname()`; a direct visit sends nothing and lets
        // the route label it from the User-Agent — "Chrome on macOS", which is
        // to a browser session what a hostname is to a machine.
        body: JSON.stringify(port ? { name, via: via || undefined } : {}),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "failed to mint token");
      if (port) {
        setState("done");
        window.location.href = `http://127.0.0.1:${port}/callback?token=${encodeURIComponent(d.token)}`;
        return;
      }
      setToken(d.token);
      setFreshId(d.id);
      setState("done");
      loadTokens();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    try {
      const r = await fetch(`/api/cli/token?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      // The route answers 200 with `ok:false` for an id that is not yours —
      // taking that as success would drop the row from the list while the
      // token kept working, which is the one lie this panel must not tell.
      if (!r.ok || d.error || d.ok === false) throw new Error(d.error || "couldn't revoke that one");
      setTokens((t) => (t ?? []).filter((x) => x.id !== id));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRevoking(null);
      setConfirmingId(null);
    }
  }

  const command = `bay login --token ${token}`;

  return (
    <>
      {/* The bar belongs here too. This page is reached from a terminal, so it
          used to be the one screen with no way back into the product — somebody
          who opened it to check which account they were about to authorize had to
          type a URL to get anywhere else. */}
      <TopBar />
      {/* 760px, not 520. The machines list is a table with four columns now, and
          a column of dates does not fit in a card sized for one sentence. */}
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-14">
        {/* Two pages, one route.
            
            With `?port=` a CLI is waiting on a loopback socket and this is a
            CONSENT screen: the click is what hands a credential to that port, and
            it has to be a click — a page that minted on load would hand a token
            to whatever is listening there, and something malicious running
            locally can name its own port.
            
            Without it nobody is waiting and nothing is being authorized. You are
            minting a token to paste. Calling both "Authorize the CLI" was a lie
            in the second case, and the machine row said "cli" — the fallback for
            a name the CLI never sent, because there is no CLI. */}
        <h1 className="text-[24px] font-[450] tracking-[-0.02em] text-ink">
          {port ? "Authorize the CLI" : "Create a CLI token"}
        </h1>

        {/* The two facts, as label-and-value rows — which is where the sentence
            that used to be here went. It said what the machine and the account
            were in prose; the rows say it in four words and stay true. */}
        <RowList>
          {acct ? (
            <Row title="Account">
              <span className="text-[13px] text-ink-2">{acct.email}</span>
            </Row>
          ) : (
            <RowSkeleton tile={false} w={88} />
          )}
          {/* Only when a machine actually asked. `os.hostname()` is what the CLI
              sends; with no CLI there is no machine to name. */}
          {port ? (
            <Row title="Machine">
              <span className="text-[13px] text-ink-2">{name}</span>
            </Row>
          ) : null}
          {/* Only when there is something to show. The literal "unknown" is what
              an agent passes when it had nothing to quote, and repeating it back
              as if it were the answer would be worse than saying nothing. */}
          {port && via && via.toLowerCase() !== "unknown" ? (
            <Row title="Your agent said">
              <span className="text-[13px] text-ink-2">&ldquo;{via}&rdquo;</span>
            </Row>
          ) : null}
        </RowList>

        {state !== "done" ? (
          <Button className="w-full" disabled={state === "working" || !acct} onClick={authorize}>
            {state === "working" ? <Loader2 className="size-4 animate-spin" /> : null}
            {state === "working"
              ? port
                ? "Authorizing…"
                : "Creating…"
              : port
                ? "Authorize"
                : "Create a token"}
          </Button>
        ) : null}

        {state === "done" && port ? (
          <p className="flex items-center gap-2 text-[14px] text-ink">
            <Check className="size-4 shrink-0" />
            Authorized. Close this tab and go back to your terminal.
          </p>
        ) : null}

        {state === "done" && !port ? (
          <div className="flex flex-col gap-2.5">
            <p className="text-[14px] text-ink">Paste this into your terminal:</p>
            {/* Mono here, and it earns it: this is characters somebody copies into
                another program, where telling 0 from O is the whole job. */}
            <button
              className="cursor-copy rounded-lg border border-border bg-ground p-3.5 text-left transition-colors hover:border-ink-3 hover:bg-tile"
              onClick={() => {
                navigator.clipboard?.writeText(command).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              type="button"
            >
              <code className="block break-all font-mono text-[12.5px] leading-[1.7] text-ink-2">
                {command}
              </code>
            </button>
            <Button
              className="w-full"
              onClick={() => {
                navigator.clipboard?.writeText(command).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              variant="outline"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy command"}
            </Button>
        </div>
      ) : null}

      {state === "error" ? <p className="text-[14px] text-red">{msg}</p> : null}

      {/* Everything already holding a key to this account, as a table.
          
          Columns rather than a name with a sentence under it: three machines all
          called "MacBook-Pro-3.local" are told apart by their dates, and dates
          buried in prose cannot be compared down a column. Which is the whole
          reason to draw a table — the row you want to revoke is the one whose
          "last used" is old. */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline gap-2 px-0.5">
          <h2 className="text-[15px] text-ink">Authorized machines</h2>
          {tokens?.length ? (
            <span className="text-[13px] text-ink-3">{tokens.length}</span>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="grid grid-cols-[minmax(0,1fr)_112px_112px_32px] items-center gap-3 border-b border-border px-4 py-2.5">
            <span className="text-[13px] text-ink-3">Name</span>
            <span className="text-[13px] text-ink-3">Added</span>
            <span className="text-[13px] text-ink-3">Last used</span>
            <span aria-hidden="true" />
          </div>

          {tokens === null
            ? [0, 1].map((i) => (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_112px_112px_32px] items-center gap-3 border-b border-border px-4 py-2.5 last:border-0"
                  key={i}
                >
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-20" />
                  <span aria-hidden="true" />
                </div>
              ))
            : null}

          {tokens?.length === 0 ? (
            <p className="px-4 py-5 text-[14px] text-ink-2">
              Nothing is authorized yet — this will be the first.
            </p>
          ) : null}

          {tokens?.map((t) => (
            <div
              className="group grid grid-cols-[minmax(0,1fr)_112px_112px_32px] items-center gap-3 border-b border-border px-4 py-2.5 transition-colors last:border-0 hover:bg-tile"
              key={t.id}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-[14px] text-ink">{t.name || "cli"}</span>
                {t.id === freshId ? (
                  <span className="shrink-0 text-[13px] text-ink-3">just now</span>
                ) : null}
              </span>
              <span className="text-[13px] tabular-nums text-ink-2">{shortDate(t.created_at)}</span>
              <span className="text-[13px] tabular-nums text-ink-2">
                {shortDate(t.last_used_at)}
              </span>

              {/* Confirmed in place. Revoking is immediate — that machine's next
                  command is rejected — so the second click is the warning, said
                  by the word on the button rather than by a paragraph under the
                  table that nobody reads until afterwards. */}
              {confirmingId === t.id ? (
                <span className="col-span-4 flex items-center gap-2 pt-1">
                  <Button
                    className="h-7 px-2.5 text-[13px]"
                    disabled={revoking === t.id}
                    onClick={() => revoke(t.id)}
                    size="sm"
                  >
                    {revoking === t.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    Revoke, it stops working now
                  </Button>
                  <Button
                    className="h-7 px-2.5 text-[13px]"
                    onClick={() => setConfirmingId(null)}
                    size="sm"
                    variant="ghost"
                  >
                    Keep
                  </Button>
                </span>
              ) : (
                <Button
                  aria-label={`Revoke ${t.name || "cli"}`}
                  className="size-7 text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => {
                    setConfirmingId(t.id);
                    setMsg("");
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CliAuth />
    </Suspense>
  );
}
