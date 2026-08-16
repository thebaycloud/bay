import { xray as liveXray, type Xray } from "./xray";
import { listBuilds as listBuildsDb, type Tick } from "./builds";
import { audienceFor, type Audience, type AudienceWindow } from "./analytics";

/**
 * Everything the X-ray shows about one app at one moment, as a single thing.
 *
 * A person and an agent are given this same object and only the rendering
 * differs. Two objects built separately would drift within a week, and the one
 * that drifted would be the one nobody was looking at — which is what happened
 * to the "deployed" line in apps/web/app/api/apps/route.ts.
 *
 * NOT A CONTRACT. This is the page's own data, the way github.com's JSON is its
 * page's data and api.github.com's is an API. No CLI reads it today. The moment
 * one does it becomes a contract silently, and renaming a field while editing
 * markup becomes a breaking change — so make that a decision, not a discovery.
 */
/**
 * The window the durable half is true for.
 *
 * `durable` — it was read, and what came back is everything there is; an empty
 * list under this window really does mean this app has never been built.
 * `unreadable` — the read failed, so the list below it is empty for a reason
 * that has nothing to do with the app. Without the second value there is no way
 * for this half to say "I could not read this", and a database outage renders,
 * to a person and to an agent alike, as "nothing ever happened".
 */
export type BuildsWindow = "durable" | "unreadable";

export interface Reading {
  slug: string;
  door: string;
  open: boolean;
  live: Xray;
  builds: Tick[];
  /**
   * People, over the last day, or null when there are none to report.
   *
   * Null covers all three of "not read", "could not be read" and "switched
   * off", which is why it is never rendered without the window beside it. The
   * same shape and the same rule as `builds`.
   */
  audience: Audience | null;
  /**
   * Three windows, not one. The live half lives in this process's memory and
   * dies with a release; builds are durable; the audience half comes from a
   * service that can be off or unreachable independently of both. Collapsing
   * them into one `since` would lie about whichever half it did not describe.
   */
  since: { live: number; builds: BuildsWindow; audience: AudienceWindow };
}

export interface ReadingDeps {
  xray: (slug: string) => Xray;
  /** The builds, or null when they could not be read — see BuildsWindow. */
  listBuilds: (slug: string) => Promise<Tick[] | null>;
  door: (slug: string) => Promise<{ door: string; open: boolean }>;
  /**
   * The audience, or null when it could not be read.
   *
   * Absent — not a function that returns null, but no function at all — is how
   * a caller says analytics is OFF for this app: no site, or the owner turned
   * it off. The two states are different sentences in the panel and this is the
   * seam that keeps them apart at the source rather than guessing later.
   */
  audience?: () => Promise<Audience | null>;
}

export async function assembleReading(slug: string, deps: ReadingDeps): Promise<Reading> {
  const live = deps.xray(slug);
  const [builds, d, audience] = await Promise.all([
    deps.listBuilds(slug),
    deps.door(slug),
    deps.audience ? deps.audience() : Promise.resolve(undefined),
  ]);
  return {
    slug, door: d.door, open: d.open, live,
    // Empty either way; the window beside it is what says which emptiness this
    // is. The live half already degrades honestly — "since this proxy started" —
    // and this is the same promise kept by the half that outlives a release.
    builds: builds ?? [],
    audience: audience ?? null,
    since: {
      live: live.since,
      builds: builds ? "durable" : "unreadable",
      // `undefined` means nobody was asked; `null` means somebody was asked and
      // could not answer. Those are the two different emptinesses this field
      // exists to tell apart, and `??` would erase the distinction.
      audience: audience === undefined ? "off" : audience === null ? "unreadable" : "read",
    },
  };
}

/** The real dependencies, for callers that are not tests. */
export const liveDeps = (
  doorOf: ReadingDeps["door"],
  /** This app's umami site, when it has one and the owner has left it on. */
  websiteId?: string | null,
): ReadingDeps => ({
  xray: liveXray,
  listBuilds: listBuildsDb,
  door: doorOf,
  audience: websiteId ? () => audienceFor(websiteId) : undefined,
});
