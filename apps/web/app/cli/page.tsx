"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { Check, Copy, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Row, RowGroup, RowList } from "@/components/panel/atoms";
import { productName } from "@/lib/brand";

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
        body: JSON.stringify({ name }),
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

  // Signing out from here has to come back here: the CLI is holding a loopback
  // port open, and dropping the visitor on the dashboard would strand it until
  // it times out.
  async function switchAccount() {
    await signOut({ redirect: false });
    const back = window.location.pathname + window.location.search;
    window.location.href = `/login?callbackUrl=${encodeURIComponent(back)}`;
  }

  const command = `bay login --token ${token}`;

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-6 px-6 py-[12vh]">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-[24px] font-[450] tracking-[-0.02em] text-ink">Authorize the CLI</h1>
        <p className="text-[15px] leading-[1.6] text-ink-2">
          This connects <span className="text-ink">{name}</span> to your {productName()} account so
          your coding agent can ship and manage apps from the terminal.
        </p>
      </header>

      <RowList>
        <Row sub="signed in as" title={acct?.email ?? "…"}>
          <Button
            className="h-7 px-2.5 text-[13px] text-ink-2 hover:text-ink"
            onClick={switchAccount}
            size="sm"
            variant="ghost"
          >
            Not you?
          </Button>
        </Row>
      </RowList>

      {state !== "done" ? (
        <Button className="w-full" disabled={state === "working"} onClick={authorize}>
          {state === "working" ? <Loader2 className="size-4 animate-spin" /> : null}
          {state === "working" ? "Authorizing…" : "Authorize"}
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

      {/* Everything already holding a key to this account. A machine you no
          longer use, or one you don't recognize, is revoked from here. */}
      <RowGroup title="Authorized machines">
        {tokens === null ? <Row sub="reading them…" title="Authorized machines" /> : null}

        {tokens?.length === 0 ? (
          <Row sub="this will be the first" title="Nothing is authorized yet" />
        ) : null}

        {tokens?.map((t) => (
          <Row
            key={t.id}
            sub={`added ${shortDate(t.created_at)} · last used ${shortDate(t.last_used_at)}`}
            title={
              <>
                {t.name || "cli"}
                {t.id === freshId ? (
                  <span className="ml-2 text-[13px] font-normal text-ink-3">just now</span>
                ) : null}
              </>
            }
          >
            {confirmingId === t.id ? (
              <>
                <Button
                  className="h-7 px-2.5 text-[13px]"
                  disabled={revoking === t.id}
                  onClick={() => revoke(t.id)}
                  size="sm"
                >
                  {revoking === t.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Revoke it
                </Button>
                <Button
                  className="h-7 px-2.5 text-[13px]"
                  onClick={() => setConfirmingId(null)}
                  size="sm"
                  variant="ghost"
                >
                  Keep
                </Button>
              </>
            ) : (
              <Button
                aria-label={`Revoke ${t.name || "cli"}`}
                className="size-7 text-ink-3 hover:text-ink"
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
          </Row>
        ))}
      </RowGroup>

      {tokens && tokens.length > 0 ? (
        <p className="px-0.5 text-[13px] leading-[1.6] text-ink-3">
          Revoking takes effect immediately — that machine’s next command is rejected and it has
          to sign in again.
        </p>
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CliAuth />
    </Suspense>
  );
}
