"use client";

import { Search } from "lucide-react";
import { xrayUrl } from "@/lib/app-urls";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { filterCommands, type CommandItem } from "@/lib/command-search";
import type { App } from "@/lib/app-row";
import { appHost } from "@/lib/brand";

/**
 * Search, on `/`.
 *
 * It was ⌘K, which is a chord you have to know; `/` is one key and the
 * convention every reader has already met on GitHub, Slack and Gmail. It also
 * costs nothing to claim — ⌘K is Chrome's own address-bar shortcut and had to be
 * fought for with preventDefault.
 *
 * The trigger and the overlay are one component so they cannot disagree about
 * whether the palette is open.
 */
/**
 * Where a bare `/` is a character rather than a command.
 *
 * Any field the reader might be typing in, including the palette's own input.
 * Without this, searching for a path — or writing anything at all in a form —
 * opens the palette instead of typing a slash, which is the failure mode every
 * site that ships this shortcut has had to fix.
 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}
export function CommandPalette({ apps }: { apps: App[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Apps, and only apps. Both commands that used to sit at the top — New app and
  // Settings — are permanent rows in the rail two hundred pixels away; a search
  // box earns its keep on the things too numerous to pin, which here is the app
  // list and nothing else.
  const items: CommandItem[] = useMemo(
    () => apps.map((a) => ({
      id: `app:${a.slug}`,
      label: a.name || a.slug,
      hint: appHost(a.slug),
      // The app's own X-ray, not the platform's page about it.
      href: xrayUrl(a.slug),
    })),
    [apps],
  );

  const results = useMemo(() => filterCommands(items, query), [items, query]);

  // A shrinking result list must not leave the highlight past the end.
  const active = Math.min(cursor, Math.max(results.length - 1, 0));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        // Otherwise the slash lands in whatever the browser focuses next — and
        // in Firefox it opens quick-find.
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    // The input mounts with the overlay, so focusing has to wait for the paint.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  function go(item?: CommandItem) {
    if (!item) return;
    setOpen(false);
    // An app's X-ray is on the app's OWN origin, which the client router cannot
    // route to — `router.push` handles paths within this app and quietly does
    // nothing useful with another host. The palette's whole promise is that
    // typing a name gets you there, so an absolute URL leaves through the
    // browser instead.
    if (/^https?:\/\//.test(item.href)) {
      window.location.href = item.href;
      return;
    }
    router.push(item.href);
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(active + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    }
  }

  return (
    <>
      <button className="kbar" onClick={() => setOpen(true)}>
        <Search size={13} />Search<span className="kbd">/</span>
      </button>

      {open ? (
        <div className="cp-overlay" onMouseDown={() => setOpen(false)}>
          <div className="cp-panel" onMouseDown={(e) => e.stopPropagation()}>
            <div className="cp-field">
              <Search size={14} />
              <input
                ref={inputRef}
                className="cp-input"
                placeholder="Search apps…"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
                onKeyDown={onInputKey}
              />
              <span className="kbd">ESC</span>
            </div>

            <div className="cp-list">
              {results.length === 0 ? (
                <div className="cp-empty">Nothing matches “{query.trim()}”</div>
              ) : results.map((item, i) => (
                <button
                  key={item.id}
                  className={`cp-row${i === active ? " on" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(item)}
                >
                  <span className="cp-label">{item.label}</span>
                  {item.hint ? <span className="cp-hint">{item.hint}</span> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
