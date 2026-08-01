"use client";

import { SunMedium } from "lucide-react";

import { nextTheme, writeTheme, type Theme } from "@/lib/theme";

export function ThemeToggle() {
  function toggle() {
    const el = document.documentElement;
    // The attribute is what is on screen: the boot script in <head> has already
    // put the stored choice there, and its absence means nothing was chosen.
    const attr = el.getAttribute("data-theme");
    const current: Theme | null = attr === "light" || attr === "dark" ? attr : null;
    const chosen = nextTheme(
      current,
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    );

    el.setAttribute("data-theme", chosen);
    writeTheme(window.localStorage, chosen);
  }
  return (
    <button className="btn icon theme-toggle" title="Toggle theme" onClick={toggle}>
      <SunMedium size={16} />
    </button>
  );
}
