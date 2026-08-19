"use client";

/**
 * Where DomainsPanel's outcomes go now.
 *
 * It reports "domain added, point its DNS here" through an `onToast` callback the
 * Cockpit used to own, and the Cockpit is gone. This is a small standalone toast
 * rather than a new dependency: one at a time, four seconds, dismissable by click,
 * and it announces itself to a screen reader because the whole point of the message
 * is that the DNS step is not finished yet.
 */
let node: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string) {
  if (typeof document === "undefined") return;
  if (!node) {
    node = document.createElement("div");
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.className =
      "fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-full border border-border " +
      "bg-card px-4 py-2 text-sub text-ink shadow-lg";
    node.addEventListener("click", () => node?.remove());
    document.body.appendChild(node);
  } else if (!node.isConnected) {
    document.body.appendChild(node);
  }
  node.textContent = message;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => node?.remove(), 4000);
}
