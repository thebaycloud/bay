import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import {
  THEME_KEY,
  themeBootScript,
  nextTheme,
  readTheme,
  writeTheme,
  type ThemeStorage,
} from "../lib/theme";

function fakeStorage(initial: Record<string, string> = {}): ThemeStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

/** Safari in private mode, and any browser with storage blocked, throws on access. */
function hostileStorage(): ThemeStorage {
  return {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

test("a choice survives the round trip through storage", () => {
  const s = fakeStorage();
  writeTheme(s, "light");
  assert.equal(readTheme(s), "light");
});

test("nothing stored means no preference, not a default", () => {
  assert.equal(readTheme(fakeStorage()), null);
});

test("a value we did not write is not a theme", () => {
  assert.equal(readTheme(fakeStorage({ [THEME_KEY]: "solarized" })), null);
});

test("storage that throws leaves the page working", () => {
  assert.equal(readTheme(hostileStorage()), null);
  assert.doesNotThrow(() => writeTheme(hostileStorage(), "light"));
});

test("with no choice yet, the toggle moves away from the system setting", () => {
  assert.equal(nextTheme(null, true), "light");
  assert.equal(nextTheme(null, false), "dark");
});

test("with a choice, the toggle flips it regardless of the system setting", () => {
  assert.equal(nextTheme("light", true), "dark");
  assert.equal(nextTheme("dark", false), "light");
});

/**
 * The boot script is the half that makes the choice stick: it runs in <head>
 * before first paint. Run it the way the browser would.
 */
function runBootScript(storage: unknown): string | null {
  let applied: string | null = null;
  const documentElement = {
    setAttribute: (name: string, value: string) => {
      if (name === "data-theme") applied = value;
    },
  };
  vm.runInNewContext(themeBootScript, {
    localStorage: storage,
    document: { documentElement },
  });
  return applied;
}

test("the boot script restores a stored theme before paint", () => {
  assert.equal(runBootScript(fakeStorage({ [THEME_KEY]: "light" })), "light");
  assert.equal(runBootScript(fakeStorage({ [THEME_KEY]: "dark" })), "dark");
});

test("the boot script leaves the system setting alone when nothing was chosen", () => {
  assert.equal(runBootScript(fakeStorage()), null);
  assert.equal(runBootScript(fakeStorage({ [THEME_KEY]: "solarized" })), null);
});

test("the boot script does not break a page whose storage throws", () => {
  assert.doesNotThrow(() => runBootScript(hostileStorage()));
});
