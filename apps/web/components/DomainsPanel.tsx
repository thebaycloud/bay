"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Row, RowGroup, RowList } from "@/components/panel/atoms";
import { recordFor } from "@/lib/dns-record";
// The team's seam, on top of roots.ts: one place that knows what we are called
// and where we answer. Two hardcoded `supersonic.cv` strings in this copy would
// have gone on claiming the old name after the cutover.
import { appHost } from "@/lib/brand";
import { rootDomain } from "@/lib/roots";
import { cn } from "@/lib/utils";

/**
 * Connecting a domain, from the person's side.
 *
 * Two things this panel refuses to do, both learned from what the state machine
 * behind it can honestly say:
 *
 *  - It never claims a domain is live because we created a certificate. `live`
 *    means Google is serving that certificate, which is the only version of the
 *    claim a browser will agree with.
 *  - It never shows a bare spinner. A row waiting on the PERSON shows the button
 *    that finishes it; a row waiting on US says what we are doing. Those are
 *    different sentences because only one of them is somebody's to act on, and a
 *    single "waiting…" for both is what makes a domain feel stuck.
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

/**
 * The records to create, written so a coding agent can act on it.
 *
 * Names the CHOICE rather than both records flatly: an apex cannot be a CNAME
 * and a subdomain should not be an A, and the one thing an agent must not do is
 * create both. It does not guess which — label counting is wrong for
 * `acme.co.uk` — so it states the rule and lets whoever runs it apply it.
 */
function agentPrompt(hostname: string, dns: Dns): string {
  const r = recordFor(hostname, dns);
  return (
    `Add this DNS record for ${hostname} so it points at my app on Bay:\n\n` +
    `  type   ${r.type}\n` +
    `  name   ${r.name}\n` +
    `  value  ${r.value}\n\n` +
    `Then tell me it is done. HTTPS turns itself on within about ten minutes of\n` +
    `the record going live — nothing needs redeploying.`
  );
}

/**
 * The hostname, which is also the copy button.
 *
 * Two icon buttons used to sit beside it — an eye and a copy — on every row,
 * which is six controls for a list of three addresses, none of them labelled.
 * The name is the thing you want on your clipboard, so the name is what you
 * click; the tooltip says so on hover, and says "Copied" once it has happened.
 *
 * Not a link as well. Opening and copying from one element means one of the two
 * has to be a modifier nobody discovers, and copying is what people came for —
 * the address is in the row, so opening it is a paste away.
 */
function CopyName({ host }: { host: string }) {
  const [done, setDone] = useState(false);
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="rounded-sm text-[15px] font-[450] text-ink transition-colors hover:text-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red"
            onClick={() => {
              navigator.clipboard?.writeText(`https://${host}`).catch(() => {});
              setDone(true);
              setTimeout(() => setDone(false), 1600);
            }}
            type="button"
          >
            {host}
          </button>
        </TooltipTrigger>
        {/* Ink, not `bg-primary`. The registry default is the brand red, and red
            in this panel means something is wrong — a tooltip that says "Copy
            URL" must not look like a warning. */}
        <TooltipContent className="bg-ink text-[12px] text-white" side="top">
          {done ? "Copied" : "Copy URL"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
  /**
   * The hostname whose records are being shown, if any.
   *
   * Opened by a successful add, and reopenable from the row — a person who
   * closes it before saving the record has nowhere else to read it, and the
   * records are the only part of this that cannot be worked out from the row.
   */
  const [records, setRecords] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * Whether a check is in flight, and whether one has finished.
   *
   * `checked` is a counter and not a boolean because the answer is often the
   * same twice — "still nothing" — and a boolean that is already true renders
   * nothing new, so the second press would look ignored.
   */
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      const d = await (
        await fetch(`/api/apps/${slug}/domains${force ? "?force=1" : ""}`)
      ).json();
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
      setRecords(hostname);
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
      // No toast: the modal IS the confirmation, and it carries the one thing
      // that has to happen next.
      setRecords(r.domain.hostname);
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

  // The first missing half, if any. One suggestion at a time: two of these would
  // read as a list of things wrong rather than one thing to consider.
  const suggestion = domains
    .map((d) => pairFor(d.hostname))
    .find((h): h is string => Boolean(h) && !domains.some((d) => d.hostname === h));

  const rows = (
    <>
      {/* The address we issued, FIRST and always.
          
          It belongs in this list because it is one of the addresses this app
          answers on — the one that works before any DNS exists and the one a
          person falls back to. It has no state (it cannot be anything but live)
          and no delete (it cannot be given up), so what it carries instead are
          the two things anybody ever does with an address.
          
          `dns.cname` rather than a string built here: the API already answers
          with the canonical `<slug>.<root>`, and building a second copy of it in
          the browser is how the two come to disagree on cutover day. */}
      {dns ? (
        <Row title={<CopyName host={dns.cname} />}>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-[var(--green)]"
            />
            <span className="text-[13px] text-ink-2">live</span>
          </span>
        </Row>
      ) : null}

      {domains.map((d) => (
        <Row
          key={d.hostname}
          // The action sits with the NAME, not at the far end of the row: it is
          // about this domain, and 900px away from it read as a column of
          // buttons rather than as one domain's next step.
          after={
            d.status === "pending_dns" || d.status === "failed" ? (
              <Button
                className="h-7 px-2.5 text-[13px]"
                onClick={() => setRecords(d.hostname)}
                size="sm"
                variant="outline"
              >
                {d.status === "failed" ? "Check the record" : "Set up"}
              </Button>
            ) : null
          }
          title={<CopyName host={d.hostname} />}
        >
          {/* Only where there is nothing to do. A row waiting on the person has
              its button beside the name and needs no state as well — the button
              is the state. */}
          {d.status === "live" || d.status === "securing" ? (
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  d.status === "live" ? "bg-[var(--green)]" : "bg-ink-3",
                )}
              />
              <span className="text-[13px] text-ink-2">
                {d.status === "live" ? "live" : "getting a certificate"}
              </span>
            </span>
          ) : null}

          {/* A recheck only while it is OURS to finish. On a pending domain the
              modal's Reload is the same read, offered where the record is. */}
          {d.status === "securing" ? (
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
      ))}
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
              className="h-9"
              disabled={busy}
              onChange={(e) => setHost(e.currentTarget.value)}
              placeholder="yourapp.com"
              value={host}
            />
            {/* h-9, matching the Input. The default button is 40px and the input
                36px, which read as two controls that had not met. */}
            <Button className="h-9 shrink-0" disabled={busy || !host.trim()} type="submit">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Connect
            </Button>
          </form>

          {err ? <p className="text-[14px] text-red">{err}</p> : null}

          {suggestion ? (
            <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
              <span>
                Visitors will also type <span className="text-ink-2">{suggestion}</span>.
              </span>
              <Button disabled={busy} onClick={() => addPair(suggestion)} size="sm" variant="outline">
                <Plus className="size-3.5" />
                Add it too
              </Button>
            </p>
          ) : null}

          {visibility !== "public" && (
            <p className="text-[13px] text-ink-3">
              This app is {visibility}, so visitors on your domain are sent to{" "}
              {appHost(slug)} to sign in — sign-in only works at that address. Make the
              app public to have your domain answer for it.
            </p>
          )}
        </>
      ) : (
        <p className="text-[13px] text-ink-3">
          Custom domains are on Pro. Your app keeps its {rootDomain()} address — upgrade
          to point your own domain at it.
        </p>
      )}
    </>
  );

  const prompt = records && dns ? agentPrompt(records, dns) : "";
  const record = records && dns ? recordFor(records, dns) : null;
  /** The row this modal is about, as the last read left it. */
  const current = records ? domains.find((d) => d.hostname === records) : undefined;

  /**
   * The records, as the thing you do next.
   *
   * A modal rather than a block under the form, because creating a DNS record
   * happens in somebody else's control panel — a tab away — and a person comes
   * back to this page to find out whether it worked. It is dismissable (the
   * close in the corner) and reopenable from the row, so it is never the only
   * copy of something they still need.
   *
   * Two ways out at the bottom, which are the two things that actually happen
   * next: hand it to the agent that is already open, or come back having done
   * it by hand and ask again.
   */
  const modal = (
    <Dialog
      onOpenChange={(o) => {
        if (o) return;
        setRecords(null);
        // The verdict belongs to one visit. Reopening to read the record again
        // must not show a "still nothing" from ten minutes ago as if it were
        // just measured.
        setChecked(0);
      }}
      open={Boolean(records && dns)}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[560px] gap-0 overflow-hidden p-0">
        <DialogHeader className="px-5 pb-4 pt-5">
          <DialogTitle className="min-w-0 truncate text-[17px] font-[450] tracking-[-0.01em]">
            Point {records} here
          </DialogTitle>
          <DialogDescription className="sr-only">
            The DNS record to add so {records} serves this app.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 pb-5">
          {/* ONE record, decided here rather than offered as a choice — an apex
              cannot be a CNAME and a subdomain should be one, and that rule is
              ours to apply. Type, Name, Value: the three fields every DNS panel
              asks for, in that order, and the Name is the label alone because
              panels append the zone themselves. */}
          {record ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-2.5">
                <span className="text-[13px] text-ink-3">Type</span>
                <span className="font-mono text-[13px] text-ink">{record.type}</span>
              </div>
              <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-2.5">
                <span className="text-[13px] text-ink-3">Name</span>
                <span className="font-mono text-[13px] text-ink">{record.name}</span>
              </div>
              <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
                <span className="text-[13px] text-ink-3">Value</span>
                <span className="truncate font-mono text-[13px] text-ink">{record.value}</span>
              </div>
            </div>
          ) : null}

          {/* The answer, in the modal, after a check.
              
              `Reload` used to re-read the list and CLOSE this — which looks
              exactly like a button that did nothing, since the row behind it
              rarely changes on the first press. A person who has just saved a
              DNS record is asking one question, and it deserves answering
              where they asked it. */}
          {checked > 0 && !checking && current ? (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg px-3.5 py-3 text-[13px] leading-[1.6]",
                current.status === "live" || current.status === "securing"
                  ? "bg-tile text-ink"
                  : "bg-tint text-red-ink",
              )}
              // Announced, because pressing the button and reading the result is
              // the whole interaction and a screen reader would otherwise get
              // silence.
              role="status"
            >
              {current.status === "live" ? (
                <>
                  <Check className="mt-px size-4 shrink-0" />
                  <span>It’s live. {records} is serving your app over HTTPS.</span>
                </>
              ) : current.status === "securing" ? (
                <>
                  <Check className="mt-px size-4 shrink-0" />
                  <span>
                    Found the record. The certificate is being issued — usually about ten
                    minutes, and nothing for you to do.
                  </span>
                </>
              ) : (
                // Two refusals, two different next actions. "No record yet" is
                // waiting; "points at 1.2.3.4 instead" is a record that exists
                // and is wrong, and telling somebody to wait for propagation
                // there sends them away from the thing they have to fix.
                <span>
                  {(current.detail ?? "").startsWith("points at")
                    ? `That name ${current.detail} — change the value above and check again.`
                    : `${current.detail ?? "The record isn’t visible yet"}. DNS can take a few minutes to spread after you save it.`}
                </span>
              )}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              className="flex-1"
              onClick={() => {
                navigator.clipboard?.writeText(prompt).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Hand to my agent"}
            </Button>
            <Button
              className="flex-1"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                // Forced: the throttle is there to stop a poll generating load,
                // not to answer a deliberate question with the last answer.
                await load(true);
                setChecking(false);
                setChecked((n) => n + 1);
              }}
              variant="outline"
            >
              {checking ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {checking ? "Checking…" : "Check DNS"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  // Nested: the domains join the parent list's rows, and everything that is not
  // a row (the add form and the notes) sits in one padded strip under them.
  if (nested) {
    return (
      <>
        {rows}
        <div className="flex flex-col gap-2.5 px-4 py-3.5">{body}</div>
        {modal}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <h2 className="px-0.5 text-[15px] text-ink">Your own domain</h2>
      <RowList>{rows}</RowList>
      {body}
      {modal}
    </div>
  );
}
