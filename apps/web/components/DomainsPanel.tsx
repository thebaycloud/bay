"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, RowGroup, RowList, StatusChip } from "@/components/panel/atoms";

/**
 * Connecting a domain, from the person's side.
 *
 * Two things this panel refuses to do, both learned from what the state machine
 * behind it can honestly say:
 *
 *  - It never claims a domain is live because we created a certificate. `live`
 *    means Google is serving that certificate, which is the only version of the
 *    claim a browser will agree with.
 *  - It never shows a bare spinner. Every waiting state carries what it is
 *    waiting for, because "waiting for DNS" and "you pointed it somewhere else"
 *    look identical otherwise, and only one of them is something to act on.
 */

type Status = "pending_dns" | "securing" | "live" | "failed";

interface Domain {
  hostname: string;
  status: Status;
  detail: string | null;
  checkedAt: number | null;
  liveAt: number | null;
}

interface Dns { ip: string; cname: string }

/**
 * How the four states read to a person. Platform words never appear here.
 *
 * The tone is StatusChip's, so a domain's state is drawn by the same dot as
 * every other state in the panel — green for arrived, red for something to fix,
 * grey for still moving. Grey and not red while waiting: DNS taking an hour is
 * not a fault.
 */
const SAID: Record<Status, { label: string; tone: "green" | "red" | "grey" }> = {
  pending_dns: { label: "waiting for your DNS", tone: "grey" },
  securing: { label: "getting a certificate", tone: "grey" },
  live: { label: "live", tone: "green" },
  failed: { label: "no certificate", tone: "red" },
};

/**
 * The other half of a domain, when there obviously is one.
 *
 * `acme.com` and `www.acme.com` are one thing to a person and two hostnames to a
 * certificate, and somebody who attaches only the first finds out when a visitor
 * types the second. Offered rather than added silently: the www record is theirs
 * to create in DNS, and attaching a name they have no plan for would leave a
 * domain sitting in "waiting for your DNS" forever with no way to know why.
 *
 * Only the www pair, and nothing cleverer. Guessing an apex from label count is
 * wrong for `acme.co.uk`, and telling somebody to put a CNAME on their root is a
 * dead end their DNS provider refuses.
 */
function pairFor(hostname: string): string | null {
  if (hostname.startsWith("www.")) {
    const base = hostname.slice(4);
    return base.split(".").length >= 2 ? base : null;
  }
  return hostname.split(".").length === 2 ? `www.${hostname}` : null;
}

export function DomainsPanel({
  slug,
  onToast,
  /**
   * Rendered INSIDE another list — no heading, no box of its own.
   *
   * Address is a disclosure now, and a bordered list inside a bordered list is
   * two boxes for one thing. Nested, this emits bare rows that share the parent
   * list's hairlines.
   */
  nested,
}: {
  slug: string;
  onToast: (m: string) => void;
  nested?: boolean;
}) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [dns, setDns] = useState<Dns | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [visibility, setVisibility] = useState("public");
  const [loaded, setLoaded] = useState(false);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await (await fetch(`/api/apps/${slug}/domains`)).json();
      if (d.error) return;
      setDomains(d.domains ?? []);
      setDns(d.dns ?? null);
      setAllowed(d.allowed !== false);
      setVisibility(d.visibility ?? "public");
    } catch { /* a page that cannot reach the API shows what it last knew */ }
    finally { setLoaded(true); }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // Poll only while something is still moving. Reading the list is also what
  // advances it (see lib/domain-attach.ts), so this is the loop that carries a
  // domain from "written down" to "live" while the person watches — and it stops
  // the moment there is nothing left to watch.
  useEffect(() => {
    if (!loaded) return;
    const moving = domains.some((d) => d.status !== "live" && d.status !== "failed");
    if (!moving) return;
    // Just over the server's own recheck window (RECHECK_MS in lib/domain-attach),
    // so every poll is a poll that can actually learn something.
    timer.current = setTimeout(load, 12_000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [domains, loaded, load]);

  /** Adds a hostname the person did not type — the www half of one they did. */
  async function addPair(hostname: string) {
    setBusy(true);
    setErr("");
    try {
      const r = await (
        await fetch(`/api/apps/${slug}/domains`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostname }),
        })
      ).json();
      if (r.error) {
        setErr(r.error);
        return;
      }
      onToast(`${hostname} added — point its DNS here too`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const typed = host.trim();
    if (!typed) return;
    setBusy(true); setErr("");
    try {
      const r = await (await fetch(`/api/apps/${slug}/domains`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: typed }),
      })).json();
      if (r.error) { setErr(r.error); return; }
      setHost("");
      onToast(`${r.domain.hostname} added — point its DNS here and it goes live on its own`);
      await load();
    } finally { setBusy(false); }
  }

  async function remove(hostname: string) {
    setBusy(true); setErr("");
    try {
      const r = await (await fetch(`/api/apps/${slug}/domains?hostname=${encodeURIComponent(hostname)}`, {
        method: "DELETE",
      })).json();
      if (r.error) { setErr(r.error); return; }
      onToast(`${hostname} removed`);
      await load();
    } finally { setBusy(false); }
  }

  const waiting = domains.some((d) => d.status !== "live");

  // The first missing half, if any. One suggestion at a time: two of these would
  // read as a list of things wrong rather than one thing to consider.
  const suggestion = domains
    .map((d) => pairFor(d.hostname))
    .find((h): h is string => Boolean(h) && !domains.some((d) => d.hostname === h));

  const rows = (
    <>
      {domains.map((d) => {
            const said = SAID[d.status] ?? SAID.pending_dns;
            return (
              <Row
                key={d.hostname}
                // The detail is part of the sub, not a line below the row: it says
                // WHAT is being waited for, and "waiting" without it and "you
                // pointed it somewhere else" look identical.
                sub={d.status !== "live" ? d.detail ?? undefined : undefined}
                title={<span className="font-mono text-[13px]">{d.hostname}</span>}
              >
                <StatusChip text={said.label} tone={said.tone} />
                {/* A recheck is just another read — the GET reconciles, and the
                    throttle is ten seconds. Worth a button because the poll is
                    twelve seconds long and somebody who just saved a DNS record
                    is watching this row. */}
                {d.status !== "live" ? (
                  <Button
                    aria-label={`Check ${d.hostname} now`}
                    className="size-7 text-ink-3 hover:text-ink"
                    disabled={busy}
                    onClick={() => load()}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  aria-label={`Remove ${d.hostname}`}
                  className="size-7 text-ink-3 hover:text-ink"
                  disabled={busy}
                  onClick={() => remove(d.hostname)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </Row>
            );
      })}
    </>
  );

  const body = (
    <>
      {allowed ? (
        <>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input
              className="h-9 font-mono text-[13px]"
              disabled={busy}
              onChange={(e) => setHost(e.currentTarget.value)}
              placeholder="yourapp.com"
              value={host}
            />
            <Button disabled={busy || !host.trim()} type="submit">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Connect
            </Button>
          </form>

          {err ? <p className="text-[14px] text-red">{err}</p> : null}

          {suggestion ? (
            <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
              <span>
                Visitors will also type <span className="font-mono text-ink-2">{suggestion}</span>.
              </span>
              <Button disabled={busy} onClick={() => addPair(suggestion)} size="sm" variant="outline">
                <Plus className="size-3.5" />
                Add it too
              </Button>
            </p>
          ) : null}

          {/* Shown while anything is still waiting, and after adding — this is
              the one place the records a person has to create are written down,
              so it cannot be behind a state they have already left. */}
          {dns && (domains.length === 0 || waiting) && (
            <>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <Row
                  sub="for a subdomain — shop.yourapp.com"
                  title={<span className="font-mono text-[13px]">CNAME</span>}
                >
                  <span className="font-mono text-[13px] text-ink-2">{dns.cname}</span>
                </Row>
                <Row
                  sub="for the domain itself — yourapp.com"
                  title={<span className="font-mono text-[13px]">A</span>}
                >
                  <span className="font-mono text-[13px] text-ink-2">{dns.ip}</span>
                </Row>
              </div>
              <p className="text-[13px] text-ink-3">
                HTTPS turns on by itself, usually within ten minutes of the record going
                live. Nothing to redeploy.
              </p>
            </>
          )}

          {visibility !== "public" && (
            <p className="text-[13px] text-ink-3">
              This app is {visibility}, so visitors on your domain are sent to{" "}
              {slug}.supersonic.cv to sign in — sign-in only works at that address. Make
              the app public to have your domain answer for it.
            </p>
          )}
        </>
      ) : (
        <p className="text-[13px] text-ink-3">
          Custom domains are on Pro. Your app keeps its supersonic.cv address — upgrade
          to point your own domain at it.
        </p>
      )}
    </>
  );

  // Nested: the domains join the parent list's rows, and everything that is not
  // a row (the add form, the DNS records, the notes) sits in one padded strip
  // under them.
  if (nested) {
    return (
      <>
        {rows}
        <div className="flex flex-col gap-2.5 px-4 py-3.5">{body}</div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <h2 className="px-0.5 text-[15px] text-ink">Your own domain</h2>
      {domains.length > 0 ? <RowList>{rows}</RowList> : null}
      {body}
    </div>
  );
}
