"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TopBar } from "@/components/TopBar";
import { Row, RowGroup } from "@/components/panel/atoms";
import { Billing, type BillingAccount } from "@/components/Billing";
import { RowSkeleton } from "@/components/Skeleton";

/**
 * Settings, on the product's own design system.
 *
 * It was `set-card` / `set-head` / `kv` / `env-row` / `btn primary` — class names
 * from the injected drawer's stylesheet, which this app does not load, so every
 * control rendered as a browser default. Same defect as the four dev panels, in
 * the one screen a person opens to check facts about their account.
 *
 * Rows and groups, at the app list's 1080px measure, under the same top bar. The
 * sidebar went with the dashboard rebuild; this page was the last thing still
 * rendering it.
 */

interface Account extends BillingAccount {
  email: string;
  name: string | null;
  provider: string;
  hasPassword: boolean;
}
interface Tok {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

const providerLabel: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  credentials: "Email & password",
};

function shortDate(s: string | null): string {
  if (!s) return "never";
  try {
    return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

export default function Settings() {
  const router = useRouter();
  const [acct, setAcct] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [tokens, setTokens] = useState<Tok[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const [confirm, setConfirm] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");

  useEffect(() => {
    fetch("/api/account")
      .then((r) => r.json())
      .then((d) => {
        if (d.email) {
          setAcct(d);
          setName(d.name ?? "");
        }
      })
      .catch(() => {});
    fetch("/api/account/tokens")
      .then((r) => r.json())
      .then((d) => setTokens(d.tokens ?? []))
      .catch(() => setTokens([]));
  }, []);

  async function saveName() {
    setSavingName(true);
    setNameSaved(false);
    const r = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setSavingName(false);
    if (r.ok) {
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    }
  }

  async function revoke(id: string) {
    const r = await fetch("/api/account/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revoke: id }),
    });
    setConfirmingId(null);
    if (r.ok) setTokens((t) => (t ?? []).filter((x) => x.id !== id));
  }

  async function del() {
    setDelBusy(true);
    setDelErr("");
    const r = await fetch("/api/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setDelErr(d.error || "Couldn't delete the account.");
      setDelBusy(false);
      return;
    }
    await signOut({ redirect: false });
    router.push("/login");
  }

  const canDelete =
    !delBusy && confirm.trim().toLowerCase() === (acct?.email ?? "").toLowerCase() && Boolean(acct);

  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-[28px] font-[450] tracking-[-0.02em] text-ink">Settings</h1>
          <p className="text-[15px] text-ink-2">Your account, plan and CLI access</p>
        </header>

        <RowGroup title="Account">
          {/* A skeleton, not `acct?.email ?? "…"`. An ellipsis beside the words
              "how you sign in" reads as a value that IS an ellipsis, and the row
              then jumps to a different width when the real one lands. */}
          {acct ? (
            <Row sub="how you sign in" title={acct.email}>
              <span className="text-[13px] text-ink-2">
                {providerLabel[acct.provider] ?? acct.provider}
              </span>
            </Row>
          ) : (
            <RowSkeleton tile={false} w={196} />
          )}

          {/* The form is a row of the list rather than a block under it: the
              name being edited belongs beside the account it names. */}
          <form
            className="flex items-center gap-2 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveName();
            }}
          >
            <Input
              aria-label="Your name"
              className="h-9"
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="your name"
              value={name}
            />
            <Button className="h-9 shrink-0" disabled={savingName || !acct} type="submit">
              {savingName ? (
                <Loader2 className="size-4 animate-spin" />
              ) : nameSaved ? (
                <Check className="size-4" />
              ) : null}
              {nameSaved ? "Saved" : "Save"}
            </Button>
          </form>
        </RowGroup>

        {/* Plan, usage and billing — its own component because it grew from a
            plan badge and one button into four meters, a reset date and two
            different ways to change plan. */}
        <Billing acct={acct} />

        <RowGroup title="CLI access">
          {tokens === null ? (
            <>
              <RowSkeleton tile={false} w={168} />
              <RowSkeleton tile={false} w={148} />
            </>
          ) : null}

          {tokens?.length === 0 ? (
            <Row sub="run `bay login` on a machine to create one" title="Nothing authorized yet" />
          ) : null}

          {tokens?.map((t) => (
            <Row
              key={t.id}
              sub={`added ${shortDate(t.created_at)} · last used ${shortDate(t.last_used_at)}`}
              title={t.name || "token"}
            >
              {/* Confirmed in place, because revoking is immediate and cannot be
                  undone — that machine's next command is rejected. */}
              {confirmingId === t.id ? (
                <>
                  <Button className="h-7 px-2.5 text-[13px]" onClick={() => revoke(t.id)} size="sm">
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
                  aria-label={`Revoke ${t.name || "token"}`}
                  className="size-7 text-ink-3 hover:text-ink"
                  onClick={() => setConfirmingId(t.id)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </Row>
          ))}
        </RowGroup>

        <RowGroup title="Delete account">
          <Row
            sub="every app you own, its database, its files and its address"
            title="This cannot be undone"
          />
          <form
            className="flex items-center gap-2 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canDelete) del();
            }}
          >
            {/* The email, typed. A button behind a confirmation somebody can
                click through is a button with no confirmation. */}
            <Input
              aria-label="Type your email to confirm"
              className="h-9"
              onChange={(e) => setConfirm(e.currentTarget.value)}
              placeholder="type your email to confirm"
              value={confirm}
            />
            <Button className="h-9 shrink-0" disabled={!canDelete} type="submit">
              {delBusy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete account
            </Button>
          </form>
        </RowGroup>

        {delErr ? <p className="px-0.5 text-[14px] text-red">{delErr}</p> : null}
      </div>
    </>
  );
}
