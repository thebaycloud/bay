/**
 * Two pieces, both taken straight from the bridge.
 *
 *   FrameGuides  the two cables — vertical lines that bound the content column
 *                and run the whole height of the page. Grey, so red stays the
 *                colour of the towers and nothing else on the page competes
 *                with them.
 *
 *   Tower        a tower laid on its side, used as a section divider. Upright it
 *                is two legs joined by crossbeams with rectangular portals
 *                between them; rotated a quarter turn that becomes two rails and
 *                a row of openings spanning the page.
 *
 * The portals are not evenly divided. On the real tower they grow toward the
 * base, so the openings here widen toward the middle — that asymmetry is the
 * only thing separating this from a plain ladder.
 */

/**
 * Content column width — the guides sit on its edges and every section spans it.
 *
 * A CSS expression rather than a fixed number so it stays generous on a large
 * display instead of stranding the content in a narrow strip with huge empty
 * margins. The cap keeps line lengths sane on very wide monitors.
 */
export const COL = "min(88vw, 1340px)";

/* ------------------------------------------------------------------ */

/**
 * The cables. One element for the whole page rather than one per section, so
 * the lines are continuous through every divider instead of restarting.
 * Belongs in a `relative` wrapper around the entire page content.
 */
export function FrameGuides() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
      <div className="relative mx-auto h-full" style={{ maxWidth: COL }}>
        <span className="absolute inset-y-0 left-0 w-px bg-[#C8CDD2]" />
        <span className="absolute inset-y-0 right-0 w-px bg-[#C8CDD2]" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
