import type { FilmRail, FilmScenario } from "@/components/film/ship-it";
import { ALL_STAGES } from "@/lib/stage-names";

/**
 * The deploy, as the film sees it.
 *
 * The picture (components/film/ship-it.js) is cut on stage boundaries: a ship
 * is built in a graving dock, launched, and sails under the Golden Gate at
 * sunrise, and every cut lands on a beat the deploy actually reports. This
 * module is the join between the two, and it is deliberately a table rather
 * than a heuristic — the film must never be a second, prettier opinion about
 * what a deploy is doing. If it shows the keel being laid, `render` started.
 *
 * Pure on purpose: it runs in the browser, and it is the only part of this
 * feature worth testing, because it is the only part that can be WRONG rather
 * than merely ugly.
 */

/**
 * Which shot each stage name gets.
 *
 * Some rails take several stages, and each grouping is a claim about what the
 * viewer is being shown:
 *
 *   - the four handoff stages are one beat, `dispatch`, because a person
 *     waiting has no use for the difference between Cloud Run scheduling a
 *     container and tsx transpiling our import tree. It is all "somebody
 *     picked the job up".
 *   - `unpack` is `clone`: source arriving on the quay, whether it came off a
 *     git remote or out of an upload.
 *   - `infer-services` is `detect`, which is what it is — a second look at the
 *     same repository.
 *   - `fleet-pull` and `fleet-boot` are `fleet`. They are written by the NODE,
 *     off its own sync, and land whenever it gets round to it — including on a
 *     restart that has nothing to do with this deploy. Folding them into the
 *     beat they decompose means a stray one cannot move the film.
 *
 * `deploy` — the activation stage — maps to the static lane's own beat, where
 * it means "served from the edge, no node, no image". On the container lane it
 * is a parent span that opens before `upload` and closes after `fleet`, and
 * the container cut of the film has no such rail, so the film ignores it. That
 * is not a special case here: `setStage` returns false for a rail the loaded
 * scenario does not have, which is exactly the right answer.
 */
export const RAIL_FOR_STAGE: Readonly<Record<string, FilmRail>> = {
  "run-record": "run-record",
  "job-dispatch": "dispatch",
  "job-cold-start": "dispatch",
  "job-launch": "dispatch",
  "job-import": "dispatch",
  "run-fetch": "dispatch",
  clone: "clone",
  unpack: "clone",
  detect: "detect",
  "infer-services": "detect",
  plan: "plan",
  render: "render",
  build: "build",
  "repair-agent": "repair-agent",
  upload: "upload",
  release: "release",
  fleet: "fleet",
  "fleet-pull": "fleet",
  "fleet-boot": "fleet",
  deploy: "deploy",
  verify: "verify",
};

/**
 * Stages that are only ever recorded once they are over.
 *
 * Everything in the pipeline is timed with `around` or `start`/`end`, so its
 * start is announced as it happens. The handoff is not: those four stages are
 * reconstructed AFTER the fact, by a process that did not exist while they were
 * running — you cannot announce the start of your own cold start. They arrive
 * as four `end`s in a row, all at once, and a film that only cuts on starts
 * would sit on the first shot through the entire dark half of the deploy and
 * then jump.
 *
 * So for these, and only these, the end IS the cut. It is honest: by the time
 * we can say anything at all about the dispatch, the dispatch has happened.
 */
const RETROSPECTIVE = new Set(["job-dispatch", "job-cold-start", "job-launch", "job-import", "run-fetch"]);

/** Every stage name that exists has a shot. Asserted in test/deploy-film.test.ts. */
export const UNMAPPED_STAGES: readonly string[] = ALL_STAGES.filter((s) => !(s in RAIL_FOR_STAGE));

/** What the film is being told to show, derived from the events so far. */
export interface FilmDrive {
  /** Which cut is loaded. Changes at most once per deploy, when a build fails. */
  scenario: FilmScenario;
  /** The beat to play to and hold at. Null before the deploy has said anything. */
  rail: FilmRail | null;
  /**
   * True from the moment a build FAILS, not from the moment the agent starts.
   *
   * The film needs the earlier instant: the break — plates letting go at deck
   * level — happens inside its build beat, and cutting to the repair drone
   * without it would skip the only shot that says what went wrong.
   */
  broke: boolean;
  /** The deploy ended, either way. */
  done: boolean;
  failed: boolean;
  /** The app and address for the endcard, as soon as they are known. */
  app: string;
  url: string;
}

export const START: FilmDrive = {
  scenario: "container", rail: null, broke: false, done: false, failed: false, app: "", url: "",
};

/** The shape of what the deploy stream carries. Everything is optional: this is the wire. */
interface DeployEvent {
  type?: string;
  stage?: string;
  phase?: string;
  outcome?: string;
  slug?: string;
  url?: string;
  line?: string;
  stack?: { framework?: string; language?: string };
}

/**
 * Fold one deploy event into what the film should be showing.
 *
 * Advances on stage STARTS. A stage's end says a thing is finished, and the
 * film has nothing to cut to on that news — the next start is the cut. The one
 * end that matters is a failed build, which is the film's only event.
 */
export function drive(prev: FilmDrive, event: unknown): FilmDrive {
  const e = (event ?? {}) as DeployEvent;
  switch (e.type) {
    case "run":
      // The run row exists — which is literally the film's first beat, "the
      // deploy exists as a record before anything is done to it".
      return prev.rail ? prev : { ...prev, rail: "run-record" };

    case "start":
      return { ...prev, app: e.slug || prev.app };

    case "detected": {
      // The static lane is a different film: no image, no node, nothing to
      // pull. Decided off the detector rather than off a log line because the
      // cut has to be chosen before the build, and this is the last event that
      // arrives in time.
      const s = e.stack ?? {};
      const isStatic = s.language === "static" || s.framework === "prebuilt";
      return isStatic && !prev.broke ? { ...prev, scenario: "static" } : prev;
    }

    case "stage": {
      const rail = e.stage ? RAIL_FOR_STAGE[e.stage] : undefined;
      if (!rail) return prev;
      if (e.phase === "start") {
        // The agent taking over is the moment the cut is certain, even if the
        // build's own failure was somehow missed.
        const scenario = rail === "repair-agent" ? "repair" : prev.scenario;
        return { ...prev, rail, scenario, broke: prev.broke || rail === "repair-agent" };
      }
      if (e.phase === "end" && e.stage && RETROSPECTIVE.has(e.stage)) {
        return { ...prev, rail };
      }
      if (e.phase === "end" && rail === "build" && e.outcome === "failed") {
        // Load the repair cut and go back to its build beat, which is the one
        // that breaks. `rail` stays "build" — the driver reads the scenario
        // change and re-seeks.
        return { ...prev, scenario: "repair", broke: true, rail: "build" };
      }
      return prev;
    }

    case "done":
      return { ...prev, rail: "done", done: true, url: e.url || prev.url, app: e.slug || prev.app };

    case "error":
      // No rail change: the film holds wherever the deploy stopped, which is
      // the honest last frame. A ship that never sailed does not get a sunrise.
      return { ...prev, done: true, failed: true };

    default:
      return prev;
  }
}

/**
 * The index in `rails` the film should advance to, or -1 to stay put.
 *
 * The film never runs backwards — a deploy does not — so this looks forward
 * from where it is. The exception is the repair cut, which contains `build`
 * twice: the first is the hull letting go, the second is the same move again
 * with the patch in it, and jumping to the wrong one would either skip the
 * break or replay it.
 */
export function railIndex(rails: readonly string[], rail: string, from: number): number {
  for (let i = Math.max(0, from); i < rails.length; i++) if (rails[i] === rail) return i;
  return -1;
}
