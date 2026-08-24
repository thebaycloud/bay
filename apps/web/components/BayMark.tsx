/**
 * The mark, monochrome.
 *
 * Derived from `public/logo-bay.svg` — the same geometry, so the towers, the
 * cables and their spacing are the logo's and not a redraw of it. What is dropped
 * is everything that only existed because the logo has a coloured tile behind it:
 * the background square, the hairline gaps that were the background showing
 * through the deck and the towers, and the rivets. At the sizes this is used —
 * 32 to 40 pixels — those are sub-pixel details that read as noise.
 *
 * `currentColor` throughout, which is the whole reason this is a component rather
 * than an `<img src="/logo-bay.svg">`: an empty state's mark should be the same
 * grey as the text under it, and an image cannot inherit that.
 */
export function BayMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      // Tight to the drawing, measured from the geometry rather than guessed: the
      // bridge spans y 12 to 180 of the logo's 200 box, and that padding belongs
      // to the tile, not to the mark. Wider than tall, so it letterboxes inside a
      // square class and centres itself.
      viewBox="0 12 200 168"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M100 18 Q40 106 0 124" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
      <path d="M100 18 Q160 106 200 124" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
      <rect x="73.0" y="53.3" width="3.2" height="80.7" fill="currentColor"/>
      <rect x="123.8" y="53.3" width="3.2" height="80.7" fill="currentColor"/>
      <rect x="53.6" y="77.2" width="3.2" height="56.8" fill="currentColor"/>
      <rect x="143.2" y="77.2" width="3.2" height="56.8" fill="currentColor"/>
      <rect x="35.5" y="96.5" width="3.2" height="37.5" fill="currentColor"/>
      <rect x="161.3" y="96.5" width="3.2" height="37.5" fill="currentColor"/>
      <rect x="20.6" y="109.9" width="3.2" height="24.1" fill="currentColor"/>
      <rect x="176.2" y="109.9" width="3.2" height="24.1" fill="currentColor"/>
      <rect x="8.3" y="118.7" width="3.2" height="15.3" fill="currentColor"/>
      <rect x="188.5" y="118.7" width="3.2" height="15.3" fill="currentColor"/>
      <rect x="76" y="92" width="15" height="42" fill="currentColor"/>
      <rect x="109" y="92" width="15" height="42" fill="currentColor"/>
      <rect x="79" y="58" width="13" height="28" fill="currentColor"/>
      <rect x="108" y="58" width="13" height="28" fill="currentColor"/>
      <rect x="82" y="22" width="11" height="28" fill="currentColor"/>
      <rect x="107" y="22" width="11" height="28" fill="currentColor"/>
      <rect x="74" y="86" width="52" height="6" fill="currentColor"/>
      <rect x="77" y="50" width="46" height="8" fill="currentColor"/>
      <rect x="78" y="12" width="44" height="10" fill="currentColor"/>
      <rect x="76" y="134" width="15" height="46" fill="currentColor"/>
      <rect x="109" y="134" width="15" height="46" fill="currentColor"/>
      <rect x="0" y="134" width="200" height="9" fill="currentColor"/>
    </svg>
  );
}
