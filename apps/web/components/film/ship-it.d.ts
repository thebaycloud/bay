/**
 * The film's outside contract.
 *
 * `ship-it.js` is the motion study's own JavaScript, kept as JavaScript on
 * purpose: it is 1,500 lines of camera moves and geometry that we want to be
 * able to re-sync with the study when the picture changes, and a hand-typed
 * port would be a fork. The types it has to honour live here instead, so
 * everything that DRIVES it is checked even though the picture is not.
 */

/**
 * A beat of the film, named after the deploy stage it shows.
 *
 * Every one of these is a real stage name from lib/stage-names.ts except
 * `done`, which is the film's last shot and the deploy's `done` event. That
 * correspondence is the whole point: see lib/deploy-film.ts.
 */
export type FilmRail =
  | "run-record" | "dispatch" | "clone" | "detect" | "plan" | "render"
  | "build" | "repair-agent" | "upload" | "release" | "fleet" | "deploy"
  | "verify" | "done";

/** Which cut of the film is loaded. A failing build swaps `container` for `repair`. */
export type FilmScenario = "container" | "repair" | "static";

/** One line in the film's own log box. `k` is the glyph: ✓, ◆, ✕ or nothing. */
interface FilmLogLine {
  /** Seconds since the deploy started, shown in the gutter. */
  t: number;
  k: "" | "g" | "a" | "e";
  m: string;
}

/** What the film says about the app it is showing, over the scenario's fiction. */
interface FilmIdentity {
  app?: string;
  /** The address on the endcard — the one the person is about to open. */
  url?: string;
  lane?: string;
  node?: string;
  release?: string;
  /** The endcard's second line. Defaults to the film's own runtime. */
  meta?: string;
}

export interface FilmHandle {
  /** Jump to a fraction of the whole film. */
  seek(f: number): void;
  seconds(): number;
  scenario(k: FilmScenario): void;
  shots(): string[];
  /** The rails of the loaded scenario, in order. `repair` has `build` twice. */
  stages(): FilmRail[];
  stage(): { i: number; rail: FilmRail; holding: boolean };
  next(): void;
  /**
   * Play to that stage and hold there, camera still moving, until the next
   * one arrives. Takes an index when the same rail appears twice — a repaired
   * deploy builds the ship, breaks it, and builds it again.
   *
   * False when the loaded scenario has no such stage, which is not an error:
   * a container deploy has no `deploy` beat and a static one has no `fleet`.
   */
  setStage(x: FilmRail | number): boolean;
  hold(): void;
  mode(m: "film" | "stages"): void;
  identity(o: FilmIdentity): void;
  /** Show the deploy's own log instead of the scenario's scripted one. */
  log(lines: FilmLogLine[]): void;
  /** Give the GPU back. Safe to call twice. */
  destroy(): void;
}

interface FilmOptions {
  scenario?: FilmScenario;
  /** Wire the player's own controls, for a surface that draws them. */
  controls?: boolean;
  preserveDrawingBuffer?: boolean;
}

/**
 * Build the film inside `root`, which must contain a `[data-el="cv"]` canvas.
 *
 * Never throws: if WebGL is missing or the scene fails to build, the returned
 * handle accepts every call and does nothing. A deploy must not stop because a
 * picture of it would not draw.
 */
export function mountFilm(root: HTMLElement, opts?: FilmOptions): FilmHandle;
