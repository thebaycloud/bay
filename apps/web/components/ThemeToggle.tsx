"use client";

import { SunMedium } from "lucide-react";

export function ThemeToggle() {
  function toggle() {
    const el = document.documentElement;
    const cur = el.getAttribute("data-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    el.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  }
  return (
    <button className="btn icon theme-toggle" title="Toggle theme" onClick={toggle}>
      <SunMedium size={16} />
    </button>
  );
}
