"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { LayoutGrid, Settings, LogOut, Sparkles, X, Plus, Terminal, Loader2, ChevronUp } from "lucide-react";
import { Mark } from "@/components/Mark";
import { Paywall } from "./Paywall";
import type { App } from "./AppsGrid";

interface Acct {
  email: string;
  name: string | null;
  plan: "basic" | "pro";
  access?: "trial" | "active" | "locked";
  trialEndsAt?: string | null;
  usage?: { apps: number; maxApps: number | null; maxGrants: number | null };
}

/**
 * What the fleet is doing, for the rail.
 *
 * The same list the dashboard renders, read for its shape rather than its
 * contents: how many are up, how many are not, and which are mid-deploy. Handed
 * in by the page when the page already has it — the apps route is one query and
 * the home page has just run it — and fetched only where it does not, which
 * today is Settings.
 *
 * The poll arms itself the way the grid's does: a building app changes on its
 * own, everything else changes because the person did something.
 */
function useFleet(initial?: App[]) {
  const [apps, setApps] = useState<App[]>(initial ?? []);
  const building = apps.filter((a) => a.status === "building");

  const active = building.length > 0;
  useEffect(() => {
    let stop = false;
    const read = () => fetch("/api/apps")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!stop && d?.apps) setApps(d.apps); })
      .catch(() => {});

    // The page handed us a list, so the first paint is already right; anywhere
    // else the rail has to ask once before it can say anything.
    if (!initial) read();
    // Fast while something is building, slow otherwise but never off: a deploy
    // started from the CLI while this tab sits on Settings is exactly the case
    // the strip exists for, and it cannot arrive if nothing is listening.
    const id = setInterval(read, active ? 4000 : 30_000);
    return () => { stop = true; clearInterval(id); };
  }, [initial, active]);

  return {
    apps,
    building,
    // `ready` is the database's status, not a probe: the rail must not wake
    // twenty scale-to-zero apps every time someone opens Settings. The grid
    // asks the apps themselves, one request per card, on the page where that
    // cost buys something.
    live: apps.filter((a) => a.ready && a.status !== "building").length,
    down: apps.filter((a) => !a.ready && a.status !== "building").length,
  };
}

/**
 * How long the closing animation runs, in one place.
 *
 * The stylesheet and this file have to agree: unmount early and the exit is cut
 * off mid-flight, unmount late and the menu sits there invisible, eating the
 * click that was meant for whatever is underneath it.
 */
const MENU_EXIT_MS = 150;

/** "6 days left", for a trial that means nothing as a bare date. */
function trialLeft(endsAt?: string | null): string {
  if (!endsAt) return "";
  const ms = Date.parse(endsAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const days = Math.ceil(ms / 86_400_000);
  return days === 1 ? "1 day left" : `${days} days left`;
}

// Persistent left rail: brand, nav, what the fleet is doing, and the account
// block pinned to the bottom.
export function Sidebar({ active, apps: initialApps }: { active?: "apps" | "settings"; apps?: App[] }) {
  const [acct, setAcct] = useState<Acct | null>(null);
  const [showPlans, setShowPlans] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fleet = useFleet(initialApps);

  useEffect(() => {
    fetch("/api/account").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.email) setAcct(d); }).catch(() => {});
  }, []);

  /**
   * Closing is a state, not an unmount.
   *
   * React removes the node the instant `open` goes false, which is why a menu
   * built this way has an entrance and no exit — the element is gone before a
   * closing animation could paint a single frame. It stays mounted through the
   * exit, marked `data-state="closed"` for the stylesheet, and leaves when the
   * animation is done.
   */
  const closeMenu = useCallback(() => {
    if (exitTimer.current) return; // already on its way out
    setClosing(true);
    exitTimer.current = setTimeout(() => {
      exitTimer.current = null;
      setClosing(false);
      setMenuOpen(false);
      setConfirmOut(false);
    }, MENU_EXIT_MS);
  }, []);

  // A timer that outlives its component would call setState on nothing.
  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); }, []);

  // Escape closes it, the same as every menu the person has used before.
  useEffect(() => {
    if (!menuOpen || closing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, closing, closeMenu]);

  const initial = (acct?.name || acct?.email || "?").trim().charAt(0).toUpperCase();
  const onTrial = acct?.access === "trial";
  const canUpgrade = onTrial || acct?.plan === "basic";
  const meter = acct?.usage && acct.usage.maxApps != null ? acct.usage : null;
  const left = onTrial ? trialLeft(acct?.trialEndsAt) : "";

  return (
    <aside className="sidebar">
      <Link href="/" className="side-brand"><span className="logo"><Mark size={15} onDark /></span>SUPERSONIC</Link>

      {/*
        Grouped, and labelled. Two unlabelled links in a 232px column read as an
        afterthought; the labels are what make it a rail rather than a pair of
        buttons, and they leave an obvious place to put the next section.
      */}
      <nav className="side-nav">
        <div className="side-label">Fleet</div>
        <Link href="/" className={"side-nav-item" + (active === "apps" ? " active" : "")}>
          <LayoutGrid size={16} />Apps
          {/* The count belongs where the list is, not only in the page heading. */}
          {fleet.apps.length > 0 && <span className="tail">{fleet.apps.length}</span>}
        </Link>
        <Link href="/new" className="side-nav-item"><Plus size={16} />New app</Link>

        <div className="side-label">Manage</div>
        <Link href="/settings" className={"side-nav-item" + (active === "settings" ? " active" : "")}><Settings size={16} />Settings</Link>
        {/* /cli has existed and been unreachable from the chrome: the only way
            in was to know the URL. */}
        <Link href="/cli" className="side-nav-item"><Terminal size={16} />CLI</Link>
      </nav>

      <div className="side-spacer" />

      {/*
        A deploy in flight, from anywhere in the product. Until now it was
        visible only on the apps grid: start one from the CLI, open Settings,
        and the rail said nothing while the thing you were waiting on ran.
      */}
      {fleet.building.length > 0 && (
        <div className="side-block">
          <div className="side-label">Deploying</div>
          {fleet.building.slice(0, 3).map((b) => (
            <Link key={b.slug} className="dep-strip" href={`/apps/${b.slug}?tab=deployments`}>
              <div className="ds-top">
                <span className="ds-nm">{b.name || b.slug}</span>
                <Loader2 size={13} className="spin" />
              </div>
              <div className="ds-stage">{b.stage || "working…"}</div>
              {/* Indeterminate on purpose: the pipeline reports stages, not a
                  percentage, and a bar that invents one is a lie that ticks. */}
              <div className="ds-bar"><span /></div>
            </Link>
          ))}
          {fleet.building.length > 3 && (
            <div className="side-more">+{fleet.building.length - 3} more</div>
          )}
        </div>
      )}

      {/*
        The shape of the fleet, in the space that was an empty spacer. The
        numbers existed on the apps page and nowhere else, so the answer to "is
        anything broken" cost a navigation.
      */}
      {fleet.apps.length > 0 && (
        <div className="side-block">
          <div className="side-label">Health</div>
          <div className="hz">
            <span className="hz-i live"><span className="d" />{fleet.live} live</span>
            {fleet.down > 0 && <span className="hz-i down"><span className="d" />{fleet.down} down</span>}
            {fleet.building.length > 0 && <span className="hz-i building"><span className="d" />{fleet.building.length} building</span>}
          </div>
        </div>
      )}

      {acct && (
        <div className="side-acct">
          {/*
            The identity row is the control now. Sign out was a permanent button
            in the rail — a destructive action with the same weight as Settings,
            sitting there on every page — and the row above it, the one with the
            person's own name on it, did nothing at all. This is the pattern the
            cockpit rail already uses; the classes are its classes.
          */}
          <div className="foot-wrap">
            <button
              className={"side-acct-id" + (menuOpen && !closing ? " open" : "")}
              onClick={() => {
                if (menuOpen) closeMenu();
                else { setMenuOpen(true); setConfirmOut(false); }
              }}
              aria-expanded={menuOpen && !closing}
            >
              <span className="acct-av">{initial}</span>
              <div className="acct-idtxt">
                {acct.name && <div className="acct-name">{acct.name}</div>}
                <div className="acct-email">{acct.email}</div>
              </div>
              <ChevronUp className="foot-chev" size={14} />
            </button>
            {menuOpen && (
              <>
                {/* A full-screen catcher rather than a document listener: one
                    click anywhere closes it, and it cannot leak past unmount. */}
                <div className="dd-backdrop" onClick={closeMenu} />
                {/* The attribute the animation hangs off, named as Radix names
                    it so the two halves are obviously one thing. */}
                <div className="foot-menu" data-state={closing ? "closed" : "open"}>
                  <Link href="/settings" className="dd-item" onClick={closeMenu}>
                    <Settings size={15} />Settings
                  </Link>
                  {confirmOut ? (
                    <>
                      <div className="dd-confirmq">Sign out of Supersonic?</div>
                      <button className="dd-item dd-danger" onClick={() => signOut({ callbackUrl: "/login" })}><LogOut size={15} />Yes, sign out</button>
                      <button className="dd-item" onClick={() => setConfirmOut(false)}><X size={15} />Cancel</button>
                    </>
                  ) : (
                    <button className="dd-item" onClick={() => setConfirmOut(true)}><LogOut size={15} />Sign out</button>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="side-acct-plan">
            <span className={"plan-tag" + (onTrial || acct.plan === "pro" ? " pro" : "")}>
              <Sparkles size={13} />{onTrial ? "Trial" : acct.plan === "pro" ? "Pro" : "Basic"}
            </span>
            {canUpgrade && <button className="btn sm primary" onClick={() => setShowPlans(true)}>Upgrade</button>}
          </div>
          {/* The clock the tag never showed. `trialEndsAt` has been in the
              account payload since trials shipped and nothing read it, so the
              rail said "Trial" on day one and on the last day alike. */}
          {left && <div className="trial-left">{left}</div>}
          {meter && (
            <div className="usage">
              <div className="usage-row"><span>Apps</span><span>{meter.apps}/{meter.maxApps}</span></div>
              <div className="usage-bar"><span style={{ width: `${Math.min(100, (meter.apps / (meter.maxApps || 1)) * 100)}%` }} /></div>
            </div>
          )}
        </div>
      )}

      {showPlans && <Paywall reason="choose_plan" onClose={() => setShowPlans(false)} />}
    </aside>
  );
}
