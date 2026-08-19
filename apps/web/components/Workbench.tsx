"use client";

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The workbench: a chat rail beside the running app, and a dev mode holding the
 * detail. Replaces the drawer that was injected into every hosted app's HTML.
 *
 * `Chat | Dev` swaps the RIGHT pane only. The rail is mounted once and stays
 * across a mode switch, because an answer is allowed to send you into a dev
 * screen and the thread has to survive that.
 *
 * Chat shows the app in an iframe of `<slug>.supersonic.cv`. That is cross-origin
 * but same-site — both are subdomains of supersonic.cv — so the app's own cookies
 * still reach it and a logged-in app previews logged in. It needs the proxy to
 * send `frame-ancestors https://app.supersonic.cv` and to stop sending
 * `X-Frame-Options`, which has no allowlist form; until that lands the frame is
 * blank for any app that sets either. See
 * docs/superpowers/specs/2026-08-19-app-workbench-design.md §3.
 */

type Mode = "chat" | "dev";
export type AppState = "live" | "shipping" | "broken";

const STATE_WORD: Record<AppState, string> = {
  live: "afloat",
  shipping: "shipping",
  broken: "broken",
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
  const [mode, setMode] = useState<Mode>("chat");

  return (
    <div className="wb">
      <div className="wb-top">
        <span className={`wb-pill wb-${state}`}>
          <b />
          {slug}
          <span className="wb-pill-st">{STATE_WORD[state]}</span>
        </span>

        {/* A recessed track with a raised white thumb, not two buttons with a
            divider and an ink-filled selection. */}
        <div className="wb-seg" role="tablist" aria-label="Mode">
          <span className={`wb-thumb wb-thumb-${mode}`} aria-hidden="true" />
          <button
            role="tab"
            aria-selected={mode === "chat"}
            className={mode === "chat" ? "on" : ""}
            onClick={() => setMode("chat")}
          >
            Chat
          </button>
          <button
            role="tab"
            aria-selected={mode === "dev"}
            className={mode === "dev" ? "on" : ""}
            onClick={() => setMode("dev")}
          >
            Dev
          </button>
        </div>

        <a className="wb-addr" href={`https://${address}`} target="_blank" rel="noreferrer">
          {address}
          <ArrowUpRight size={14} strokeWidth={2} />
        </a>
      </div>

      <div className="wb-body">
        <div className="wb-rail">
          <div className="wb-thread">
            <p className="wb-rail-empty">
              Ask about your app — how many users, what broke, what the last ship
              did. Answers come from a read-only agent reading your app&rsquo;s own
              data.
            </p>
          </div>
          {/* Deliberately disabled rather than absent: the shell is being
              reviewed for layout, and a composer that looked live would be the
              dead control this codebase keeps refusing to ship. */}
          <div className="wb-composer">
            <input disabled placeholder="Chat is not wired up yet" aria-label="Ask about your app" />
          </div>
        </div>

        <div className="wb-pane">
          {mode === "chat" ? (
            <iframe
              className="wb-frame"
              src={`https://${address}`}
              title={`${slug} preview`}
              // The frame is the tenant's own app. It gets no access to this
              // page, and this page asks nothing of it: there is no element
              // picking in this design, so there is no bridge either.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}
