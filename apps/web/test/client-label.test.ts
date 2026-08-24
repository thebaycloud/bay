import test from "node:test";
import assert from "node:assert/strict";
import { browserLabel } from "@/lib/client-label";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  operaLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0",
  firefoxWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 iPad",
};

test("a browser and a system make the label", () => {
  assert.equal(browserLabel(UA.chromeMac), "Chrome on macOS");
  assert.equal(browserLabel(UA.safariMac), "Safari on macOS");
  assert.equal(browserLabel(UA.firefoxWin), "Firefox on Windows");
});

test("the specific test wins over the general one", () => {
  // Both of these carry "Chrome/" in their own user-agent, and Chrome's own
  // carries "Safari/". Order in the table is the whole mechanism.
  assert.equal(browserLabel(UA.edgeWin), "Edge on Windows");
  assert.equal(browserLabel(UA.operaLinux), "Opera on Linux");
});

test("an iPad says Macintosh, and is not one", () => {
  assert.equal(browserLabel(UA.safariIpad), "Safari on iPad");
  assert.equal(browserLabel(UA.chromeIos), "Chrome on iPhone");
});

test("an unreadable agent still yields a label, never the raw string", () => {
  // The alternative is 180 characters in a table cell, which is not a label.
  assert.equal(browserLabel(""), "Browser");
  assert.equal(browserLabel(null), "Browser");
  assert.equal(browserLabel("curl/8.6.0"), "Browser");
  // Half an answer is better than none.
  assert.equal(browserLabel("Mozilla/5.0 (Windows NT 10.0)"), "Windows");
});
