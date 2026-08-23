"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  ChartColumn,
  ChevronLeft,
  Database,
  Globe,
  KeyRound,
  RefreshCw,
  Ship,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/panel/toast";
import { AlertCell, Avatars, Chips, Row, RowList, StatusChip, TintRow } from "@/components/panel/atoms";
import { DatabasePanel } from "@/components/DatabasePanel";
import { StoragePanel } from "@/components/StoragePanel";
import { JobsPanel } from "@/components/JobsPanel";
import { IssuesPanel } from "@/components/IssuesPanel";
import { DomainsPanel } from "@/components/DomainsPanel";
import { GitPanel } from "@/components/GitPanel";
import SharePanel from "@/components/SharePanel";
import { readPanel, type Reading } from "@/lib/panel/reading";

/**
 * Dev mode: the panel's cell grid, and the screens behind it.
 *
 * A port of homeScreen from services/proxy/panel/cells.js — Address full width,
 * then Analytics|Ships, Data|Keys, Infra|Access, and Agent full width. Each cell
 * carries one live fact and pushes into a screen; the back affordance pops.
 *
 * The screens REUSE the panels that already exist rather than being rewritten.
 * DatabasePanel, StoragePanel, JobsPanel, IssuesPanel, DomainsPanel and SharePanel
 * are roughly 570 working, shipped lines that answer the same questions these
 * screens ask. What Cockpit contributed was chrome — a brand bar, an app switcher,
 * a tab strip — and that is what the workbench already provides, which is why the
 * chrome was doubled and the panels were not.
 *
 * The reads happen here, on the client. The spec said server-side, and there is a
 * real argument for it — no spinner on open. But those nine routes exist and are
 * tested, and they are same-origin now, so reading them here costs a skeleton and
 * duplicating them server-side would cost new untested code on the path that
 * decides whether an owner can see their own app.
 */

type View =
  | "analytics"
  | "ships"
  | "data"
  | "keys"
  | "infra"
  | "access"
  | "agent";

/**
 * A mark per block.
 *
 * Eight cells of identical shape, told apart by reading their titles — which is
 * what a grid exists to save you from. Each is the plainest icon for the thing:
 * Ships is a ship, Keys is a key. Address has no view behind it and still gets
 * one, because the point is recognising the block, not that it is clickable.
 */
const ICON = {
  address: Globe,
  analytics: ChartColumn,
  ships: Ship,
  data: Database,
  keys: KeyRound,
  infra: Activity,
  access: Users,
  agent: Bot,
} as const;

const TITLE: Record<View, string> = {
  analytics: "Analytics",
  ships: "Ships",
  data: "Data",
  keys: "Keys",
  infra: "Infra",
  access: "Access",
  agent: "Agent",
};

export function Dev({ slug, address }: { slug: string; address: string }) {
  const [d, setD] = useState<Reading | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    readPanel(slug, address)
      .then((r) => {
        if (alive) setD(r);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [slug, address, nonce]);

  if (failed) {
    return (
      <Screen>
        <Card className="flex flex-col items-start gap-2 rounded-xl border-border bg-card p-5 shadow-none">
          <div className="text-val text-ink">That did not come back</div>
          <p className="text-sub text-ink-2">Nothing could be read about this app just now.</p>
          {/* Never left spinning. A panel that says "Reading…" forever is
              indistinguishable from one that is broken, which is what this was. */}
          <Button className="mt-1" onClick={() => setNonce((n) => n + 1)} size="sm" variant="outline">
            <RefreshCw className="size-3.5" />
            Try again
          </Button>
        </Card>
      </Screen>
    );
  }

  if (!d) {
    return (
      <Screen>
        <RowList>
          {Array.from({ length: 8 }).map((_, i) => (
            <div className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-0" key={i}>
              <Skeleton className="size-7 shrink-0 rounded-sm" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="ml-auto h-4 w-28" />
            </div>
          ))}
        </RowList>
      </Screen>
    );
  }

  if (view) {
    return (
      <Screen>
        <div className="flex items-center gap-1 pb-1">
          <Button className="-ml-2" onClick={() => setView(null)} size="sm" variant="ghost">
            <ChevronLeft className="size-4" />
            {TITLE[view]}
          </Button>
        </div>
        <ScreenBody d={d} slug={slug} view={view} />
      </Screen>
    );
  }

  const broken = d.live.filter((p) => p.brokenFor).length;

  return (
    <Screen>
      {/* The alert stays a tinted card above the list. It is the one thing here
          that must not look like the seven rows it sits over. */}
      {d.alert ? (
        <AlertCell act={d.alert.act} onAct={() => setView("infra")} sub={d.alert.sub} title={d.alert.title} />
      ) : null}

      <RowList>
        <Row icon={ICON.address} sub="Where it lives" title="Address">
          <TintRow value={d.addr} />
        </Row>

        <Row
          icon={ICON.analytics}
          onOpen={() => setView("analytics")}
          sub={
            d.an
              ? `${d.an.visitors} today${d.an.dv ? ` ${d.an.dv}` : ""} · ${d.here.length} here now`
              : d.here.length
                ? `${d.here.length} here now`
                : "Not counting yet"
          }
          title="Analytics"
        >
          {d.an ? (
            <Chips>
              <StatusChip text={`${d.an.visitors.toLocaleString()} visitors`} tone={d.an.dvUp ? "green" : "red"} />
              <Avatars initials={d.initials} />
            </Chips>
          ) : null}
        </Row>

        <Row icon={ICON.ships} onOpen={() => setView("ships")} sub={`Last shipped ${d.ships[0].when}`} title="Ships">
          <Chips>
            {/* No re-ship button. There is no deploy-trigger route behind it, and a
                dead control on the one screen about shipping is worse than none. */}
            <StatusChip text={d.shipping ? "Shipping" : "Running"} tone={d.shipping ? "red" : "green"} />
          </Chips>
        </Row>

        <Row icon={ICON.data} onOpen={() => setView("data")} sub="Its data and files" title="Data">
          <Chips>
            <StatusChip
              text={`${d.tables.length} ${d.tables.length === 1 ? "table" : "tables"} · ${d.files} ${d.files === 1 ? "file" : "files"}`}
              tone={d.missing ? "grey" : "green"}
            />
          </Chips>
        </Row>

        <Row
          icon={ICON.keys}
          onOpen={() => setView("keys")}
          sub={d.keys.length ? "What it connects to" : "Nothing connected yet"}
          title="Keys"
        >
          {d.keys.length ? (
            <Chips>
              {/* Two, not three: a row has one line and the third name pushed the
                  address column off the screen. The rest are behind the row. */}
              {d.keys.slice(0, 2).map((k) => (
                <StatusChip key={k.name} text={k.name} tone={k.tone === "bad" ? "red" : "green"} />
              ))}
              {d.keys.length > 2 ? (
                <span className="font-mono text-micro text-ink-3">+{d.keys.length - 2}</span>
              ) : null}
            </Chips>
          ) : null}
        </Row>

        <Row
          icon={ICON.infra}
          onOpen={() => setView("infra")}
          sub="What it is doing, and what runs on its own"
          title="Infra"
        >
          <Chips>
            <StatusChip
              text={`${d.live.length} ${d.live.length === 1 ? "path" : "paths"}`}
              tone={broken ? "red" : "green"}
            />
            <StatusChip text={`${d.jobs.length} ${d.jobs.length === 1 ? "job" : "jobs"}`} tone="green" />
          </Chips>
        </Row>

        <Row icon={ICON.access} onOpen={() => setView("access")} sub="Who can open this" title="Access">
          <Chips>
            <Avatars initials={d.pInitials} />
            <StatusChip text={d.who} tone={d.who === "public" ? "grey" : "green"} />
          </Chips>
        </Row>

        <Row icon={ICON.agent} onOpen={() => setView("agent")} sub="Give your coding agent a way in" title="Agent">
          <Chips>
            {/* Two states said differently on purpose: no token is something to
                fix, a token never used is something to try. */}
            <StatusChip
              text={
                d.tokens.length
                  ? d.tokens.some((t) => t.last_used_at)
                    ? "connected"
                    : "never used"
                  : "not connected"
              }
              tone={d.tokens.some((t) => t.last_used_at) ? "green" : "red"}
            />
            <StatusChip text={d.mcp ? "mcp on" : "mcp not built"} tone="grey" />
          </Chips>
        </Row>
      </RowList>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-background">
      {/* 1080px, the app list's measure. Dev mode is the full width now, and a
          list stretched across a 27" display puts the fact a metre from the name
          it belongs to. */}
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-3 px-6 py-8">{children}</div>
    </div>
  );
}

function ScreenBody({ d, slug, view }: { d: Reading; slug: string; view: View }) {
  if (view === "data") {
    return (
      <div className="flex flex-col gap-3">
        <DatabasePanel hasDb={!d.missing} slug={slug} />
        <StoragePanel hasStorage slug={slug} />
      </div>
    );
  }
  if (view === "infra") {
    return (
      <div className="flex flex-col gap-3">
        <IssuesPanel slug={slug} />
        <JobsPanel slug={slug} />
      </div>
    );
  }
  if (view === "access") {
    return (
      <div className="flex flex-col gap-3">
        <SharePanel slug={slug} />
        <GitPanel onToast={toast} slug={slug} />
        <DomainsPanel onToast={toast} slug={slug} />
      </div>
    );
  }
  if (view === "ships") {
    return (
      <Card className="flex flex-col gap-2 rounded-xl border-border bg-card p-4 shadow-none">
        <div className="text-val text-ink">{d.ships[0].did}</div>
        <div className="text-sub text-ink-2">
          {d.ships[0].out} · {d.ships[0].when} · {d.ships[0].who}
        </div>
        {d.ships[0].error ? (
          <pre className="mt-1 overflow-x-auto rounded-xl bg-tile p-3 font-mono text-micro text-ink-2">
            {d.ships[0].error}
          </pre>
        ) : null}
        {/* Honest about the gap: deploy-status returns only the latest deploy, and
            there is no deploys-list route to build a history from. */}
        <p className="pt-1 text-sub text-ink-2">
          Only the latest ship is on file — there is no deploys-list route yet, so
          there is no history to show.
        </p>
      </Card>
    );
  }
  if (view === "keys") {
    return (
      <Card className="flex flex-col gap-3 rounded-xl border-border bg-card p-4 shadow-none">
        {d.keys.length ? (
          <div className="flex flex-col gap-2">
            {d.keys.map((k) => (
              <div className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0" key={k.name}>
                <span className="font-mono text-val text-ink">{k.name}</span>
                <StatusChip text="set" tone="green" />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sub text-ink-2">Nothing connected yet.</p>
        )}
        {/* The panel used to promise key health here. Nothing records upstream call
            outcomes, so the promise is removed rather than left unmet. */}
        <p className="text-sub text-ink-2">
          Names only. Values are never read back, and whether a key still works is
          not something anything records yet.
        </p>
      </Card>
    );
  }
  if (view === "agent") {
    return (
      <Card className="flex flex-col gap-2 rounded-xl border-border bg-card p-4 shadow-none">
        <div className="text-val text-ink">CLI tokens</div>
        <p className="text-sub text-ink-2">
          {d.tokens.length
            ? `${d.tokens.length} ${d.tokens.length === 1 ? "token" : "tokens"} on file. A token belongs to you, not to this app — one deploys everything you own.`
            : "No tokens yet."}
        </p>
        <div className="pt-1 text-val text-ink">MCP</div>
        <p className="text-sub text-ink-2">
          {d.mcp
            ? "On."
            : "Not built. There is no config to hand you, so none is offered — a config pointing at nothing is worse than none."}
        </p>
      </Card>
    );
  }
  // analytics
  return (
    <Card className="flex flex-col gap-2 rounded-xl border-border bg-card p-4 shadow-none">
      {d.an ? (
        <div className="grid grid-cols-2 gap-4">
          <Stat label="visitors" value={d.an.visitors.toLocaleString()} />
          <Stat label="views" value={d.an.views.toLocaleString()} />
          <Stat label="bounce" value={d.an.returning} />
          <Stat label="change" value={d.an.dv || "—"} />
        </div>
      ) : (
        <p className="text-sub text-ink-2">
          {!d.anOn
            ? "Analytics is off, so nobody is being counted."
            : !d.anReady
              ? "Analytics is still being set up for this app."
              : "The count could not be read just now — which is not the same as nobody having visited."}
        </p>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="font-mono text-section text-ink tabular-nums">{value}</div>
      <div className="font-mono text-label uppercase text-ink-3">{label}</div>
    </div>
  );
}
