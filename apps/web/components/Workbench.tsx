"use client";

import { ArrowUpRight, MessageSquare, SquareTerminal } from "lucide-react";
import dynamic from "next/dynamic";
import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQueryState } from "@/lib/use-query-state";
import { cn } from "@/lib/utils";

/**
 * The rail arrives on its own.
 *
 * It is 187 KB gzipped — `ai-elements/message` pulls in `streamdown`, which
 * pulls in Shiki and KaTeX, and Shiki brings grammars for ABAP, Fortran, Verilog
 * and COBOL. That was 187 of the workbench's 347 KB, on the critical path of a
 * page somebody may well open straight into Dev mode and never chat on.
 *
 * `ssr: false` because it is a chat: there is nothing to render on the server
 * that is worth a second of hydration, and the thread starts empty.
 */
const WorkbenchChat = dynamic(
  () => import("@/components/WorkbenchChat").then((m) => ({ default: m.WorkbenchChat })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-0 flex-col justify-end gap-3 p-3">
        <Skeleton className="h-[92px] w-full rounded-xl" />
      </div>
    ),
  },
);

/**
 * The workbench: a chat rail beside the running app, and a dev mode holding the
 * detail. Replaces the drawer that was injected into every hosted app's HTML.
 *
 * Built on the shadcn primitives in components/ui, which are pointed at the
 * panel design system through the --sh- tokens in globals.css — so Radix supplies
 * the behaviour (roving tabindex on the tab list, arrow keys, correct aria wiring,
 * a scroll area that does not inherit the platform scrollbar) and the palette is
 * still ours. Hand-rolling this got the look approximately right and the keyboard
 * semantics wrong.
 *
 * `Tabs` swaps the RIGHT pane only. The rail sits outside it and is mounted once,
 * because an answer is allowed to send you into a dev screen and the thread has to
 * survive that. That is why the tab CONTENT is the pane and not the whole body.
 *
 * Dev mode is FULL SCREEN: the rail is hidden, not unmounted. The cells push into
 * screens with real tables in them, and 380px of chat was taking a quarter of the
 * width away from the thing somebody switched tabs to read. Hidden rather than
 * removed so the thread is still there on the way back.
 *
 * Chat shows the app in an iframe of `<slug>.supersonic.cv`: cross-origin but
 * same-site, so the app's own cookies still reach it and a logged-in app previews
 * logged in. It needs the proxy to send `frame-ancestors https://app.supersonic.cv`
 * and to stop sending `X-Frame-Options`, which has no allowlist form; until that
 * lands the frame is blank for any app that sets either. See
 * docs/superpowers/specs/2026-08-19-app-workbench-design.md §3.
 */

export type AppState = "live" | "shipping" | "broken";

/** The panel's own words, and the dot that carries them. Green is status and
 *  nothing else — that is why the accent cannot also mean "running". */
const STATE: Record<AppState, { word: string; dot: string }> = {
  live: { word: "afloat", dot: "bg-[var(--green)]" },
  shipping: { word: "shipping", dot: "bg-ink-3" },
  broken: { word: "broken", dot: "bg-red" },
};

export function Workbench({
  slug,
  address,
  state,
  children,
}: {
  slug: string;
  address: string;
  state: AppState;
  /** Dev mode's body: the cell grid and the screens behind it. */
  children: ReactNode;
}) {
  const { word, dot } = STATE[state];
  /**
   * Controlled, because the LAYOUT depends on which tab is open: dev mode is the
   * whole width, not a pane beside the rail. Radix would happily manage this
   * itself, but then the shell could not know what to be.
   *
   * And in the URL, so a reload keeps you where you were and the page is
   * linkable. `?tab=dev`; chat is the default and writes nothing.
   */
  const [tabParam, setTab] = useQueryState("tab", "chat");
  const tab = tabParam === "dev" ? "dev" : "chat";

  return (
    <Tabs
      className="fixed inset-0 grid grid-rows-[52px_minmax(0,1fr)] gap-0 bg-background"
      onValueChange={setTab}
      value={tab}
    >
      <header className="flex items-center gap-3 border-b border-border bg-card px-3.5">
        {/* `rounded-md`, like every other chip in this product. A pill here and
            pills on the tabs were the two things making this screen read as a
            different application from the list it is opened from. */}
        <Badge variant="outline" className="h-7 gap-2 px-2.5 font-normal">
          <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden="true" />
          <span className="text-sub font-medium text-ink">{slug}</span>
          <span className="font-mono text-[11px] tracking-[0.06em] text-ink-2">{word}</span>
        </Badge>

        <TabsList className="h-8">
          <TabsTrigger value="chat" className="gap-1.5 px-4 text-sub">
            <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="dev" className="gap-1.5 px-4 text-sub">
            <SquareTerminal size={13} strokeWidth={2} aria-hidden="true" />
            Dev
          </TabsTrigger>
        </TabsList>

        <a
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-micro text-ink-2 transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red"
          href={`https://${address}`}
          target="_blank"
          rel="noreferrer"
        >
          {address}
          <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
        </a>
      </header>

      <div
        className={cn(
          "grid min-h-0",
          tab === "dev" ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[380px_minmax(0,1fr)]",
        )}
      >
        {/* HIDDEN in dev mode, not unmounted. Dev mode is a full-screen surface —
            the cells and the screens behind them have real tables in them and a
            380px column of chat was taking a quarter of the width from the thing
            somebody switched tabs to read. But an answer is allowed to send you
            into a dev screen, so the thread has to survive the trip back. */}
        <aside
          className={cn(
            "grid min-h-0 border-r border-border bg-card",
            tab === "dev" && "hidden",
          )}
        >
          <WorkbenchChat slug={slug} />
        </aside>

        {/* The frame is NOT force-mounted: an iframe left mounted keeps the
            tenant's app running, and its timers and polling, behind a dev screen
            nobody is watching. Dev IS, below — it is nine network reads, two of
            which take a second, and Radix unmounts an inactive pane, so every
            switch back was paying for all of them again. The comment that used to
            be here claimed both panes were mounted; they were not. */}
        <TabsContent value="chat" className="m-0 min-h-0 overflow-hidden">
          <iframe
            className="block size-full border-0 bg-card"
            src={`https://${address}`}
            title={`${slug} preview`}
            // The frame is the tenant's own app. It gets no access to this page,
            // and this page asks nothing of it: there is no element picking in
            // this design, so there is no bridge either.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </TabsContent>

        <TabsContent
          className="m-0 min-h-0 overflow-hidden data-[state=inactive]:hidden"
          forceMount
          value="dev"
        >
          {children}
        </TabsContent>
      </div>
    </Tabs>
  );
}
