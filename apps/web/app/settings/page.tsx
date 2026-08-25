"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TopBar } from "@/components/TopBar";
import { Row, RowGroup } from "@/components/panel/atoms";
import { Plan, Usage, type BillingAccount } from "@/components/Billing";
import { GithubSettings } from "@/components/GithubSettings";
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
const providerLabel: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  credentials: "Email & password",
};

/**
 * The outcome of clicking a confirmation link.
 *
 * `/verify` redeems the token and redirects here with the result, because it has
 * nothing of its own to render — either the address is confirmed or the link is
 * stale, and both are one line on a page the user already has. Without this the
 * click ended on a settings page that looked exactly the same as before, which
 * reads as a link that did nothing.
 */
function VerifiedNotice() {
  const [state, setState] = useState<"1" | "0" | null>(null);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("verified");
    if (v === "1" || v === "0") {
      setState(v);
      // Take it out of the URL, so a refresh or a shared link does not repeat a
      // one-off message about something that already happened.
      const u = new URL(window.location.href);
      u.searchParams.delete("verified");
      window.history.replaceState({}, "", u.toString());
    }
  }, []);
  if (!state) return null;
  return state === "1" ? (
    <div className="flex items-center gap-2 rounded-md border border-line bg-card px-3.5 py-2.5 text-[13px] text-ink-2">
      <Check className="size-3.5 shrink-0 text-ink" />
      Your email address is confirmed.
    </div>
  ) : (
    <div className="rounded-md border border-line bg-card px-3.5 py-2.5 text-[13px] text-ink-3">
      That confirmation link has expired or was already used. We can send another one.
    </div>
  );
}

export default function Settings() {
  const router = useRouter();
  const [acct, setAcct] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

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

  /** Whether the field differs from what is stored, which is when Save exists. */
  const dirty = Boolean(acct) && name.trim() !== (acct?.name ?? "").trim();

  const canDelete =
    !delBusy && confirm.trim().toLowerCase() === (acct?.email ?? "").toLowerCase() && Boolean(acct);

  return (
    <>
      <TopBar />
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-6 py-10">
        <h1 className="text-[28px] font-[450] tracking-[-0.02em] text-ink">Settings</h1>
        <VerifiedNotice />

        <RowGroup title="Account">
          {/* Label on the left, value on the right — including the one value you
              can change. A name field that looks like every other row's value is
              a field somebody finds without being told it is there. */}
          {acct ? (
            <Row title="Email">
              <span className="text-[13px] text-ink-2">{acct.email}</span>
            </Row>
          ) : (
            <RowSkeleton tile={false} w={72} />
          )}

          {acct ? (
            <Row title="Signs in with">
              <span className="text-[13px] text-ink-2">
                {providerLabel[acct.provider] ?? acct.provider}
              </span>
            </Row>
          ) : (
            <RowSkeleton tile={false} w={104} />
          )}

          <form
            className="flex items-center gap-2 border-b border-border px-4 py-3 last:border-0"
            onSubmit={(e) => {
              e.preventDefault();
              saveName();
            }}
          >
            <span className="shrink-0 text-[15px] font-[450] text-ink">Full name</span>
            <Input
              aria-label="Full name"
              className="ml-auto h-9 w-[220px]"
              disabled={!acct}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="your name"
              value={name}
            />
            {/* Only when there is something to save. A permanently disabled
                button beside a field reads as a field you are not allowed to
                edit. */}
            {dirty || savingName || nameSaved ? (
              <Button className="h-9 shrink-0" disabled={savingName} type="submit">
                {savingName ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : nameSaved ? (
                  <Check className="size-4" />
                ) : null}
                {nameSaved ? "Saved" : "Save"}
              </Button>
            ) : null}
          </form>
        </RowGroup>

        {/* Plan and usage are separate sections: one is what you pay for, the
            other is how much of it is left. Read as one list, the plan row
            looked like the first of five limits. */}
        <Plan acct={acct} />
        <Usage acct={acct} />

        {/* Where a person checks GitHub without being mid-ship. The dialog was
            the only place this was visible, and only while shipping. */}
        <GithubSettings />

        {/* One line, not a second copy of the list. /cli is where a machine is
            authorized and revoked; a list here meant two screens showing the
            same tokens and two revoke paths to keep in step. */}
        <section className="flex flex-col gap-2.5">
          <h2 className="px-0.5 text-[15px] text-ink">CLI access</h2>
          <p className="px-0.5 text-[14px] text-ink-2">
            <Link className="text-ink underline" href="/cli">
              See the machines you have authorized
            </Link>
          </p>
        </section>

        <RowGroup title="Delete account">
          <Row title="This cannot be undone" />
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
