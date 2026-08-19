"use client";

import { ArrowUpRight, MessageSquare, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

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
  /** Dev mode's body. The Cockpit, until the screens are ported. */
  children: ReactNode;
}) {
  const { word, dot } = STATE[state];

  return (
    <Tabs
      defaultValue="chat"
      className="fixed inset-0 grid grid-rows-[52px_minmax(0,1fr)] gap-0 bg-background"
    >
      <header className="flex items-center gap-3 border-b border-border bg-card px-3.5">
        <Badge variant="outline" className="h-7 gap-2 rounded-full px-2.5 font-normal">
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

      <div className="grid min-h-0 grid-cols-[340px_minmax(0,1fr)]">
        <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] border-r border-border bg-card">
          <ScrollArea className="min-h-0">
            <p className="p-4 text-sub text-ink-2">
              Ask about your app — how many users, what broke, what the last ship
              did. Answers come from a read-only agent reading your app&rsquo;s own
              data.
            </p>
          </ScrollArea>
          <div>
            <Separator />
            {/* Disabled rather than absent. The chat engine is step 7, and a
                composer that looked live would be the dead control this codebase
                keeps refusing to ship — but the shell cannot be judged for layout
                without one in place. */}
            <div className="p-3">
              <Input disabled placeholder="Chat is not wired up yet" aria-label="Ask about your app" />
            </div>
          </div>
        </aside>

        {/* Both panes are mounted; Radix hides the inactive one. forceMount is
            deliberately NOT used on the frame — an iframe left mounted keeps the
            tenant's app running, and its timers and polling, behind a dev screen
            nobody is watching. */}
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

        <TabsContent value="dev" className="m-0 min-h-0 overflow-hidden">
          {children}
        </TabsContent>
      </div>
    </Tabs>
  );
}
