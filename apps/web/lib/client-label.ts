/**
 * What to call a token that no machine named.
 *
 * The CLI sends `os.hostname()`, so a token from a terminal is labelled
 * "MacBook-Pro-3.local" and the table below it is readable at a glance. A token
 * minted from the browser sent nothing, so it was labelled "cli" — every one of
 * them identical, in a list whose whole job is telling them apart.
 *
 * So: the same KIND of label, from the same kind of source. "Chrome on macOS" is
 * to a browser session what a hostname is to a machine.
 *
 * FROM THE USER-AGENT, AND YES THAT IS CLIENT-SUPPLIED. It is a label, shown back
 * to the person who created it and to nobody else, and it grants nothing. It is
 * not identity and must never be read as identity — the token's owner comes from
 * the session cookie, which is the only thing here that decides anything.
 *
 * Order matters twice over. Edge and Opera put "Chrome" in their own strings, and
 * every browser on iOS is Safari wearing a different name, so the specific tests
 * have to run before the general ones. Same for iPadOS, which says "Macintosh".
 */

const BROWSERS: [RegExp, string][] = [
  // Before Chrome: both of these carry "Chrome/" in their own UA.
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\//, "Opera"],
  [/\bArc\//, "Arc"],
  [/\bVivaldi\//, "Vivaldi"],
  [/\bBrave\//, "Brave"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  // Last: Safari appears in nearly every WebKit UA, including Chrome's.
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  // Before "Macintosh": an iPad reports itself as one.
  [/\biPad\b/, "iPad"],
  [/\biPhone\b/, "iPhone"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

function first(pairs: [RegExp, string][], ua: string): string | null {
  for (const [re, name] of pairs) if (re.test(ua)) return name;
  return null;
}

/**
 * "Chrome on macOS", or as much of it as the string admits.
 *
 * Never empty and never the raw user-agent: a 180-character string in a table
 * cell is not a label, and this is the only place it is read.
 */
export function browserLabel(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Browser";
  const browser = first(BROWSERS, ua);
  const system = first(SYSTEMS, ua);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Browser";
}
