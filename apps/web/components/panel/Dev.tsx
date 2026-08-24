"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChartColumn,
  ChevronLeft,
  Database,
  Globe,
  KeyRound,
  RefreshCw,
  Ship,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "@/components/panel/toast";
import {
  AlertCell,
  Avatars,
  ChipSkeleton,
  Chips,
  Row,
  RowGroup,
  RowList,
  RowNest,
  RowSection,
  StatusChip,
} from "@/components/panel/atoms";
import { DatabasePanel } from "@/components/DatabasePanel";
import { KeysPanel } from "@/components/KeysPanel";
import { LogsPanel } from "@/components/LogsPanel";
import { StoragePanel } from "@/components/StoragePanel";
import { DomainsPanel } from "@/components/DomainsPanel";
import { GitPanel } from "@/components/GitPanel";
import { useQueryState } from "@/lib/use-query-state";
import {
  deriveReading,
  readParts,
  type Part,
  type Raw,
  type Reading,
} from "@/lib/panel/reading";

/**
 * Dev mode: the panel's cell grid, and the screens behind it.
 *
 * A port of homeScreen from services/proxy/panel/cells.js — Address full width,
 * then Analytics|Ships, Data|Keys and Infra. Each cell
 * carries one live fact and pushes into a screen; the back affordance pops.
 *
 * The screens REUSE the panels that already exist rather than being rewritten.
 * DatabasePanel, StoragePanel, JobsPanel, IssuesPanel and DomainsPanel
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
  | "logs"

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
  logs: Activity,
} as const;

const TITLE: Record<View, string> = {
  analytics: "Analytics",
  ships: "Ships",
  data: "Data",
  keys: "Keys",
  logs: "Logs",
};

export function Dev({ slug, address }: { slug: string; address: string }) {
  /**
   * The answers, as they arrive, and which ones have.
   *
   * Two pieces of state and not one: `raw` is what came back, `done` is what
   * came back AT ALL — and they are different, because a read that answers
   * `null` (umami off, no database) has landed and has nothing to say. Without
   * the second, an empty answer is indistinguishable from a slow one, and the
   * row would show a skeleton forever.
   */
  const [raw, setRaw] = useState<Raw>({});
  const [done, setDone] = useState<Set<Part>>(new Set());
  /**
   * Which screen is open, in the URL.
   *
   * `?view=analytics`, so a reload lands back on the screen somebody was reading
   * and the browser's back button leaves it rather than leaving the app. Validated
   * against the union rather than cast: the value comes from a URL, which anybody
   * can type, and an unknown one has to mean "the list" and not a blank pane.
   */
  const [viewParam, setViewParam] = useQueryState("view");
  const view = viewParam && viewParam in TITLE ? (viewParam as View) : null;
  const setView = (v: View | null) => setViewParam(v);
  /**
   * Open, because the domains under Address are the answer to the question the
   * row asks. A disclosure that starts shut makes somebody click to find out
   * whether there is anything to find out.
   *
   * `replace` and not `push`: shutting a disclosure is not a place you navigated
   * to, and three of them in the history would make the back button feel broken.
   */
  const [addrParam, setAddrParam] = useQueryState("addr", "open");
  const addrOpen = addrParam !== "shut";
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setRaw({});
    setDone(new Set());
    // Nine reads, nine renders. Each `setState` is a patch, so a row draws the
    // moment its own read lands instead of behind the slowest of the nine.
    return readParts(slug, address, (key, value) => {
      setRaw((r) => ({ ...r, [key]: value }));
      setDone((s) => new Set(s).add(key));
    });
  }, [slug, address, nonce]);

  // Memoised: nine `setState` calls means nine renders, and this walks every
  // answer to build the whole Reading each time.
  const d = useMemo(() => deriveReading(slug, address, raw), [slug, address, raw]);
  /** Whether this row's own read has come back — skeleton until it has. */
  const has = (...parts: Part[]) => parts.every((p) => done.has(p));


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
      {/* The alert stays a tinted card above the groups. It is the one thing here
          that must not look like the rows it sits over. */}
      {d.alert ? (
        <AlertCell act={d.alert.act} onAct={() => setView("logs")} sub={d.alert.sub} title={d.alert.title} />
      ) : null}

      {/* Overview is a group interrupted by a card, so its list breaks in two:
          Address, then what Address opens, then the rest. The alternative — the
          card nested inside one list — put the group's own border down both
          sides of it, which is exactly what "still part of the block" means. */}
      <RowSection title="Overview">
        <RowList>
          {/* A disclosure, not a door. Every address this app answers on is a
              short list, and a screen of its own to hold four rows is a
              navigation somebody has to come back from. */}
          {/* No address on the row itself. It was there twice — as a value with an
              open and a copy beside it, and again as the first line of what the
              row opens — and the copy target you want is the one in the list, next
              to the domains it is listed with. */}
          <Row
            expanded={addrOpen}
            icon={ICON.address}
            onOpen={() => setAddrParam(addrOpen ? "shut" : "open", "replace")}
            title="Address"
          />
        </RowList>

        {addrOpen ? (
          <RowNest>
            <DomainsPanel nested onToast={toast} slug={slug} />
          </RowNest>
        ) : null}

        <RowList>
          {/* Access has left this list for the top right of the workbench header,
            where it is reachable from Chat as well and where a pending request
            is visible without going looking for it. See SharePopover. */}

          <Row icon={ICON.analytics} onOpen={() => setView("analytics")} title="Analytics">
            <Chips>
              {!has("an") ? (
                <ChipSkeleton w={116} />
              ) : d.an ? (
                <StatusChip
                  text={`${d.an.visitors.toLocaleString()} ${d.an.visitors === 1 ? "visitor" : "visitors"} today`}
                  tone={d.an.dvUp ? "green" : "red"}
                />
              ) : (
                // Not zero. Nobody counted is a different fact from nobody came.
                <StatusChip text="not counting yet" tone="grey" />
              )}
              {d.here.length ? (
                <>
                  <Avatars initials={d.initials} />
                  <StatusChip text={`${d.here.length} here now`} tone="green" />
                </>
              ) : null}
            </Chips>
          </Row>

          {/* The right-hand fact carries the STATE, which is what the sub was
              saying all along — a row does not need a label and a value when the
              value already reads as a sentence. */}
          <Row icon={ICON.ships} onOpen={() => setView("ships")} title="Ships">
            <Chips>
              {/* No re-ship button. There is no deploy-trigger route behind it, and a
                  dead control on the one screen about shipping is worse than none. */}
              {has("dep") ? (
                <StatusChip
                  text={d.shipping ? "shipping now" : `last shipped ${d.ships[0].when}`}
                  tone={d.shipping ? "red" : "green"}
                />
              ) : (
                <ChipSkeleton w={124} />
              )}
            </Chips>
          </Row>

          {/* One fact, about traffic — the jobs chip left with jobs. A failing
              path is the reason somebody opens this row, so it outranks the
              count when there is one. */}
          <Row icon={ICON.logs} onOpen={() => setView("logs")} title="Logs">
            <Chips>
              {has("live") ? (
                <StatusChip
                  text={
                    broken
                      ? `${broken} ${broken === 1 ? "path failing" : "paths failing"}`
                      : `${d.live.length} ${d.live.length === 1 ? "path" : "paths"}`
                  }
                  tone={broken ? "red" : "green"}
                />
              ) : (
                <ChipSkeleton w={64} />
              )}
            </Chips>
          </Row>
        </RowList>
      </RowSection>

      <RowGroup title="Resources">
        <Row icon={ICON.data} onOpen={() => setView("data")} title="Data">
          <Chips>
            {has("db", "store") ? (
              <StatusChip
                text={`${d.tables.length} ${d.tables.length === 1 ? "table" : "tables"} · ${d.files} ${d.files === 1 ? "file" : "files"}`}
                tone={d.missing ? "grey" : "green"}
              />
            ) : (
              <ChipSkeleton w={112} />
            )}
          </Chips>
        </Row>

        {/* A count, not the names. Three key names filled the row and were the
            one place mono was load-bearing; the names are one click away, where
            there is room for all of them. */}
        <Row icon={ICON.keys} onOpen={() => setView("keys")} title="Keys">
          <Chips>
            {has("env") ? (
              <StatusChip
                text={
                  d.keys.length
                    ? `${d.keys.length} ${d.keys.length === 1 ? "key" : "keys"} set`
                    : "nothing connected yet"
                }
                tone={d.keys.length ? "green" : "grey"}
              />
            ) : (
              <ChipSkeleton w={72} />
            )}
          </Chips>
        </Row>

        {/* There was an Agent row here, and it is gone rather than fixed.
            It carried two facts. One was the number of CLI tokens — which belong
            to the PERSON and not to the app, so it read the same on every app in
            the account, and /cli already lists them with the device, the last use
            and a revoke. The other said "MCP not built", which is a roadmap entry
            wearing a status chip. Neither was something an owner could do
            anything about from here. */}
      </RowGroup>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-background">
      {/* 1080px, the app list's measure. Dev mode is the full width now, and a
          list stretched across a 27" display puts the fact a metre from the name
          it belongs to. */}
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-6 py-8">{children}</div>
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
  if (view === "logs") {
    return (
      // Logs only. Jobs left for a section of its own — a cron is a thing that
      // runs your app, not a thing your app said — and Issues was a summary of
      // the errors that are now lines in the list below it.
      <LogsPanel slug={slug} />
    );
  }
  if (view === "ships") {
    return (
      <div className="flex flex-col gap-6">
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
        {/* One ship, because `deploy-status` returns only the latest and there is
            no deploys-list route to build a history from. Said in the commit and
            not on the screen: an owner reading this wants the ship, not our
            roadmap. */}
      </Card>

      {/* The repository, HERE and not under Access, which is where it was. "Every
          push to main ships this app" is a statement about deploys; it shared a
          screen with sharing only because both had been called access. Draws
          nothing when no repository is connected. */}
      <GitPanel onToast={toast} slug={slug} />
      </div>
    );
  }
  if (view === "keys") {
    // `managedDatabase` is a fact this screen already has: the database read came
    // back a moment ago. It decides whether the seventeen connection variables
    // are ours or the app's — an app on Supabase owns its own DATABASE_URL, and
    // treating those names as ours unconditionally would be a refusal aimed at
    // the wrong app. See `envOwner`.
    return <KeysPanel managedDatabase={!d.missing} onToast={toast} slug={slug} />;
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
      <div className="text-section text-ink tabular-nums">{value}</div>
      <div className="text-[13px] text-ink-3">{label}</div>
    </div>
  );
}
