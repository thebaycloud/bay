"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Dithering } from "@paper-design/shaders-react";

/**
 * Fog in the margins.
 *
 * Fixed and full-viewport, but the content column paints opaque paper over the
 * middle, so this is only ever seen down the outer edges. That is the whole
 * trick — there is no hole to cut and nothing to keep in sync when the column
 * width changes.
 *
 * Two layers. A CSS dot field that always renders, and the shader on top only
 * where WebGL exists, so nothing load-bearing depends on it.
 *
 * Red, but washed out — see FOG below. The guides are grey now, so the margins
 * can carry colour without the frame competing with them.
 */

/**
 * A washed-out red rather than the brand value. The margins are a field, not a
 * mark: at full strength #E63F2C down both edges reads as two more structural
 * elements competing with the towers.
 */
const FOG = "#E39383";
const DOT = "#F2C7BE";
const PITCH = "7px";

/** Soft vertical fade so the field doesn't end abruptly at the viewport edges. */
const MASK = "linear-gradient(to bottom, transparent 0%, #000 14%, #000 84%, transparent 100%)";
const MASK_STYLE = { maskImage: MASK, WebkitMaskImage: MASK } as const;

const REDUCED = "(prefers-reduced-motion: reduce)";
const noop = () => () => {};

function subscribeMotion(cb: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const motionSnapshot = () => window.matchMedia(REDUCED).matches;

// Probed once per page load; the answer cannot change.
let webglMemo: boolean | undefined;
function hasWebGL() {
  if (webglMemo === undefined) {
    const probe = document.createElement("canvas");
    webglMemo = Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  }
  return webglMemo;
}

/**
 * The field is fixed and full-viewport, so the library's own IntersectionObserver
 * never sees it leave the screen and its animation loop would run for as long as
 * the tab is open. Dropping speed to 0 stops the loop outright; the canvas keeps
 * its last frame, so the texture stays and only the motion ends.
 */
function useAnimateWhileNearTop() {
  const [near, setNear] = useState(true);

  useEffect(() => {
    let queued = false;
    const read = () => {
      queued = false;
      const now = window.scrollY < window.innerHeight;
      setNear((was) => (was === now ? was : now));
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(read);
    };
    read();
    // The page scrolls inside a fixed layer, not the window, so listen there.
    const scroller = document.querySelector("[data-scroll-root]") ?? window;
    scroller.addEventListener("scroll", onScroll, { passive: true } as AddEventListenerOptions);
    return () =>
      scroller.removeEventListener("scroll", onScroll as EventListener);
  }, []);

  return near;
}

export function Backdrop() {
  const enhance = useSyncExternalStore(noop, hasWebGL, () => false);
  const still = useSyncExternalStore(subscribeMotion, motionSnapshot, () => true);
  const near = useAnimateWhileNearTop();

  return (
    <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
      {/* Permanent floor — the texture survives with no WebGL at all. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(${DOT} 1.1px, transparent 1.1px)`,
          backgroundSize: `${PITCH} ${PITCH}`,
          opacity: enhance ? 0.28 : 0.55,
          ...MASK_STYLE,
        }}
      />

      {enhance && (
        <div className="absolute inset-0" style={MASK_STYLE}>
          <Dithering
            data-paper-shader=""
            width="100%"
            height="100%"
            /* The library defaults to minPixelRatio 2 and then scales up into an
               8.3MP budget — several times the pixels this element occupies, and
               most of why an idle page can spin a laptop's fans. */
            minPixelRatio={1}
            maxPixelCount={2_400_000}
            /* Transparent ground: the shader paints fog onto the paper rather
               than filling the margins with a colour. */
            colorBack="#00000000"
            colorFront={FOG}
            shape="wave"
            type="4x4"
            size={2}
            speed={still || !near ? 0 : 0.16}
            style={{ opacity: 0.7 }}
          />
        </div>
      )}
    </div>
  );
}
