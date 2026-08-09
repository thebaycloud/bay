import { xray as liveXray, type Xray } from "./xray";
import { listBuilds as listBuildsDb, type Tick } from "./builds";

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
export interface Reading {
  slug: string;
  door: string;
  open: boolean;
  live: Xray;
  builds: Tick[];
  /**
   * Two windows, not one. The live half lives in this process's memory and dies
   * with a release; builds are durable. Collapsing them into one `since` would
   * lie about whichever half it did not describe.
   */
  since: { live: number; builds: "durable" };
}

export interface ReadingDeps {
  xray: (slug: string) => Xray;
  listBuilds: (slug: string) => Promise<Tick[]>;
  door: (slug: string) => Promise<{ door: string; open: boolean }>;
}

export async function assembleReading(slug: string, deps: ReadingDeps): Promise<Reading> {
  const live = deps.xray(slug);
  const [builds, d] = await Promise.all([deps.listBuilds(slug), deps.door(slug)]);
  return {
    slug, door: d.door, open: d.open, live, builds,
    since: { live: live.since, builds: "durable" },
  };
}

/** The real dependencies, for callers that are not tests. */
export const liveDeps = (doorOf: ReadingDeps["door"]): ReadingDeps => ({
  xray: liveXray,
  listBuilds: listBuildsDb,
  door: doorOf,
});
