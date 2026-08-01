"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { filterCommands, type CommandItem } from "@/lib/command-search";
import type { App } from "./AppsGrid";

/**
 * ⌘K.
 *
 * The topbar has advertised this shortcut since the design system landed, but
 * the control was a bare <button> with no handler and nothing listened for the
 * key — the affordance was drawn, never wired. Pressing ⌘K did nothing, and so
 * did clicking the bar.
 *
 * The trigger and the overlay are one component so they cannot disagree about
 * whether the palette is open.
 */
export function CommandPalette({ apps }: { apps: App[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items: CommandItem[] = useMemo(
    () => [
      { id: "cmd:new", label: "New app", hint: "Deploy something", href: "/new" },
      { id: "cmd:settings", label: "Settings", hint: "Account and plan", href: "/settings" },
      ...apps.map((a) => ({
        id: `app:${a.slug}`,
        label: a.name || a.slug,
        hint: `${a.slug}.supersonic.cv`,
        href: `/apps/${a.slug}`,
      })),
    ],
    [apps],
  );

  const results = useMemo(() => filterCommands(items, query), [items, query]);

  // A shrinking result list must not leave the highlight past the end.
  const active = Math.min(cursor, Math.max(results.length - 1, 0));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // Chrome's own ⌘K focuses the address bar, so this has to be claimed.
        e.preventDefault();
        setOpen((was) => !was);
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
        <Search size={13} />Search<span className="kbd">⌘K</span>
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
