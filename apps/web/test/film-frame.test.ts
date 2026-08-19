import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The film is composed at 2.40:1, and the room gives it the window.
 *
 * `ship-it.js` is JavaScript on purpose (see ship-it.d.ts) and cannot be
 * imported here — it reaches for three.js and a WebGL context on the way in. So
 * this reads the two lines that decide the frame out of the source and checks
 * the arithmetic they encode, which is the part that can be wrong in a way
 * nobody notices until a deploy is being watched on a laptop.
 */
const SRC = readFileSync(join(__dirname, "..", "components", "film", "ship-it.js"), "utf8");

/** `framed`, lifted out of the module. */
function framed(f: number, aspect: number): number {
  const FRAME = 960 / 400;
  if (Math.abs(aspect - FRAME) < 1e-3) return f;
  const half = Math.atan(Math.tan((f * Math.PI) / 360) * (FRAME / aspect)) * 360 / Math.PI;
  return Math.min(110, half);
}

/** How wide the picture is, in degrees, at a given vertical fov and shape. */
function horizontal(fov: number, aspect: number): number {
  return Math.atan(Math.tan((fov * Math.PI) / 360) * aspect) * 360 / Math.PI;
}

test("the frame in the source is the frame this test reasons about", () => {
  // If the composition ratio or the clamp moves in ship-it.js, the assertions
  // below stop describing the film and start describing this file.
  assert.match(SRC, /const FRAME=960\/400;/);
  assert.match(SRC, /return Math\.min\(110,half\);/);
  // And the correction is actually applied to the camera rather than computed
  // and dropped — the failure that would leave every assertion here passing.
  assert.match(SRC, /fv=framed\(fv\);\s*\n\s*if\(Math\.abs\(camera\.fov-fv\)/);
});

test("a 2.40:1 frame is left exactly as it was composed", () => {
  // The dashboard and the bench both size the canvas by `aspect-ratio: 960/400`,
  // so every surface that had this framing before must get the same numbers to
  // the bit. A correction that was almost identity would be a silent re-grade of
  // every shot in the film.
  for (const fov of [26, 32, 34, 36, 40, 46, 48]) {
    assert.equal(framed(fov, 960 / 400), fov);
  }
});

test("a taller window keeps the width the shot was composed with", () => {
  // This is the whole point. A PerspectiveCamera's fov is VERTICAL, so handing
  // a 16:9 window the fov a 2.40:1 shot was framed with does not letterbox it —
  // it crops the sides, and the sides are where the bridge, the yard and the
  // city are. The vertical field opens instead, onto sky and water the scene
  // already has.
  for (const fov of [26, 34, 46]) {
    for (const aspect of [16 / 9, 3 / 2, 4 / 3]) {
      const want = horizontal(fov, 960 / 400);
      const got = horizontal(framed(fov, aspect), aspect);
      assert.ok(Math.abs(got - want) < 0.01, `${fov}deg at ${aspect}: ${got} != ${want}`);
      // …and it opened rather than closed: more vertical field, not less.
      assert.ok(framed(fov, aspect) > fov);
    }
  }
});

test("a wider window does not throw the composition away either", () => {
  // The other direction, and the same rule holds: the horizontal field is what
  // the shot was built on, so it is what is preserved and the vertical closes.
  //
  // 32:9, not 21:9 — 2.40:1 is already wider than an ultrawide monitor (21/9 is
  // 2.33), so 21:9 is a case of the test above rather than this one. Getting
  // that backwards is easy and this comment is why it is written down.
  const fov = 36;
  const aspect = 32 / 9;
  assert.ok(aspect > 960 / 400, "this case is not actually wider than the frame");
  assert.ok(Math.abs(horizontal(framed(fov, aspect), aspect) - horizontal(fov, 960 / 400)) < 0.01);
  assert.ok(framed(fov, aspect) < fov);
});

test("a phone in portrait gets a close shot, not a fisheye", () => {
  // Preserving the width of a 2.40:1 frame inside a 9:19.5 window would ask for
  // a vertical fov near 180 degrees, which is not a camera — it is a lens fault,
  // and it would land on the one viewport where the film is least able to
  // explain itself. Past the clamp the picture is allowed to crop instead.
  const tall = framed(34, 9 / 19.5);
  assert.equal(tall, 110);
  // The room refuses the film below 560px wide anyway (services/proxy/src/
  // room-page.ts), so this is the belt rather than the braces.
  assert.ok(tall <= 110);
});
