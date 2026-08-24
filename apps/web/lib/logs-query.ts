import { ALL_SINCE, SOURCES, LEVELS, type Query, type Source, type Level } from "./logs";

/**
 * The query string a log view sends, turned into a `Query`.
 *
 * In a lib rather than in the route because BOTH routes need it — the paged read
 * and the SSE tail have to interpret a filter identically, or the tail shows rows
 * the list does not. A Next.js route file may only export HTTP verbs, so sharing
 * it from there is not merely untidy, it fails the build.
 *
 * Every parameter is validated against a closed set. `since` in particular is
 * never a caller's string: it is derived from a window name that must be one of
 * five, so nothing a caller types reaches the filter as a timestamp.
 */
/** Windows the UI may ask for. A closed set, so `since` is never a caller's string. */
const WINDOWS: Record<string, number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

export function parseQuery(sp: URLSearchParams): { q: Query; window: string } {
  const window = sp.get("window") && sp.get("window")! in WINDOWS ? sp.get("window")! : "24h";
  const ms = WINDOWS[window];

  const sources = (sp.get("source") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Source => (SOURCES as string[]).includes(s));

  const faceRaw = sp.get("face");
  const levelRaw = sp.get("level");
  const status = Number(sp.get("status"));

  return {
    window,
    q: {
      sources,
      face: faceRaw === "frontend" || faceRaw === "backend" ? faceRaw : null,
      minLevel: (LEVELS as string[]).includes(levelRaw ?? "") ? (levelRaw as Level) : null,
      search: sp.get("q"),
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      method: sp.get("method"),
      path: sp.get("path"),
      since: ms === null ? ALL_SINCE : new Date(Date.now() - ms).toISOString(),
    },
  };
}

