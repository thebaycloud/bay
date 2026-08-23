"use client";

import { useEffect, useRef } from "react";
import type { FilmHandle } from "@/components/film/ship-it";
import { railIndex, type FilmDrive } from "@/lib/deploy-film";

/**
 * The deploy, as a film, driven by the deploy.
 *
 * A container deploy takes 90 seconds at p50 and 87 of them are one stage —
 * `fleet`, the node pulling the image and booting the sandbox — during which
 * the terminal below prints nothing and the person watching has no way to tell
 * a slow deploy from a stuck one. This is what fills that: a ship is built in a
 * graving dock and sails under the Golden Gate at sunrise, cut on the deploy's
 * own stage boundaries.
 *
 * It is a picture of a real thing and it must stay one. The film plays into
 * the stage it is on and then CREEPS through it — getting arbitrarily close to
 * finishing that stage and never actually finishing, until the next stage
 * event arrives. So a build that takes four minutes is four minutes of
 * plating, and the sun does not come up until the app answers. Nothing here
 * runs on a timer, which is the whole difference between this and a progress
 * bar that lies at 90%.
 *
 * What DOES run regardless is everything that is alive rather than
 * progressing: the yard works, the tide moves, the ferries cross the bay and
 * the camera re-angles every few seconds. A stage the deploy sits in for four
 * minutes is an edited sequence of a shipyard at night, not a held frame.
 *
 * The three.js scene and its 800KB of library are loaded on demand, inside the
 * effect, so nothing about the deploy page's own weight changes for a person
 * who never deploys.
 */
export function DeployFilm({ drive, elapsed, full = false }: { drive: FilmDrive; elapsed: number; full?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const film = useRef<FilmHandle | null>(null);
  // The latest instruction, kept in a ref as well as in props: the module
  // arrives asynchronously and whatever the deploy said while it was loading
  // still has to be applied — a fast static deploy can be half over by then.
  const want = useRef<{ drive: FilmDrive; elapsed: number }>({ drive, elapsed });
  // What the film has actually been told, so a re-render with nothing new in it
  // does not re-drive it. This matters more than it looks: the page ticks a
  // clock every 250ms, and re-applying a rail would walk the film forward
  // through the repair cut's SECOND build every quarter second.
  const shown = useRef({ scenario: "", rail: "", index: -1, ident: "" });

  want.current = { drive, elapsed };

  useEffect(() => {
    let dead = false;
    const root = rootRef.current;
    if (!root) return;

    import("@/components/film/ship-it").then(({ mountFilm }) => {
      if (dead) return;
      film.current = mountFilm(root, { scenario: want.current.drive.scenario });
      shown.current = { scenario: want.current.drive.scenario, rail: "", index: -1, ident: "" };
      apply();
    }).catch(() => { /* no film. The deploy is unaffected, which is the point. */ });

    return () => {
      dead = true;
      film.current?.destroy();
      film.current = null;
      shown.current = { scenario: "", rail: "", index: -1, ident: "" };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kept out of the effect body so the mount and every subsequent event go
  // through exactly one path.
  function apply() {
    const f = film.current;
    if (!f) return;
    const { drive: d, elapsed: secs } = want.current;
    const was = shown.current;

    if (d.scenario !== was.scenario) {
      // A build that failed swaps the cut for the one with the break in it, and
      // that rebuilds the scene from stage zero — so the beat we are on has to
      // be found again in the new film rather than carried over.
      f.scenario(d.scenario);
      was.scenario = d.scenario;
      was.rail = "";
      was.index = -1;
    }

    const meta = d.done && !d.failed ? `live · deployed in ${secs}s` : "";
    const ident = `${d.app}|${d.url}|${meta}`;
    if (ident !== was.ident) {
      was.ident = ident;
      f.identity({
        app: d.app || undefined,
        url: d.url ? d.url.replace(/^https?:\/\//, "") : undefined,
        meta: meta || undefined,
        // The study's ship carried a release number and a node name. A real
        // deploy does not put either on the wire, and a number nobody said is
        // a lie standing next to twelve true ones — so the film says neither.
        release: "",
        node: "",
      });
    }

    if (d.rail && d.rail !== was.rail) {
      was.rail = d.rail;
      // Forward only, from where the film already is. A deploy does not run
      // backwards, and the one rail that legitimately repeats — `build`, in the
      // cut where the agent rebuilds her — must land on the second one.
      const i = railIndex(f.stages(), d.rail, was.index + 1);
      // -1 means this cut has no such beat: a container deploy's `deploy`
      // span, a static one's `fleet`. Nothing to show, and nothing wrong.
      if (i >= 0) { f.setStage(i); was.index = i; }
    }
  }

  useEffect(apply, [drive, elapsed]);

  // `full` is the shape, not a second film: the picture takes the window and
  // the card's own chrome goes. It changes a class, so a deploy that is already
  // running is not remounted — the film watches its canvas with a
  // ResizeObserver and re-frames itself for whatever box it ends up in.
  return (
    <div className={full ? "dfilm full" : "dfilm"} ref={rootRef}>
      <div className="dfilm-bar top">
        <span data-el="tagLane">deploying…</span>
        <span className="sp" />
        <span>cel 3d · 2.40:1</span>
      </div>
      <div className="dfilm-frame">
        {/* The canvas itself is made by the film, one per mount — see the note
            on `holder` in ship-it.js. This is where it goes, and what a screen
            reader is told is in it. */}
        <div
          className="dfilm-canvas"
          data-el="cv"
          role="img"
          aria-label="An animated cutaway of this deploy: a ship built in a dry dock, launched, and sailing under the Golden Gate as it goes live."
        />
        <div className="dfilm-slate" data-el="slate" />
        <div className="dfilm-endcard" data-el="endcard">
          <b data-el="ecUrl" />
          <span data-el="ecMeta" />
        </div>
        <div className="dfilm-bang" data-el="bang" />
        <div className="dfilm-grade" data-el="grade" />
        <div className="dfilm-grain" />
        <div className="dfilm-vig" />
        <div className="dfilm-stagebar" data-el="stagebar">
          <span className="no" data-el="stageNo" />
          <b data-el="stageName" />
          <span className="note" data-el="stageNote" />
        </div>
        {/* Shown only if the film cannot start — it sets `hidden` off itself. */}
        <div className="dfilm-fallback" data-el="fallback" hidden />
      </div>
      <div className="dfilm-bar">
        <span className="st" data-el="status" />
        <span className="sp" />
        <span className="url" data-el="urlOut" />
      </div>
    </div>
  );
}
