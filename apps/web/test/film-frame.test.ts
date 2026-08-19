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

/**
 * The yard's two moving props, and the arithmetic that decides where they are.
 *
 * Both of these were reported by watching a real deploy, not by a test — which
 * is the point of writing them down now. Neither throws, neither logs, and
 * neither is visible in any frame but the one it is wrong in.
 */

/** `gantryLoad.visible`, as it was and as it is. */
const plateWasVisible = (drop: number) => drop < 0.94;
const plateIsVisible = (lc: number) => lc < 0.86;

/** The lift cycle: down over [0,.4], hold to .6, back up by 1. */
function dropAt(lc: number): number {
  const eio = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  return lc < 0.4 ? eio(lc / 0.4) : lc < 0.6 ? 1 : 1 - eio((lc - 0.6) / 0.4);
}

test("the crane does not lose the plate on the way down", () => {
  // What was reported: "у вот этой штуки пропадает плита когда она спускается".
  // The old rule hid the load whenever the hook was near the bottom, which is
  // most of the descent and all of the hold — 40% of the cycle, centred on the
  // exact moment the plate is supposed to arrive somewhere.
  const hiddenThen: number[] = [], hiddenNow: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const lc = i / 1000;
    if (!plateWasVisible(dropAt(lc))) hiddenThen.push(lc);
    if (!plateIsVisible(lc)) hiddenNow.push(lc);
  }
  // The bug, stated as a number so it cannot come back quietly: the plate used
  // to vanish while still descending.
  assert.ok(hiddenThen[0] < 0.4, "the old rule did not actually hide it during the descent");
  assert.ok(hiddenThen.length / 1000 > 0.35, "the old rule hid it for less of the cycle than reported");

  // Now: visible for the whole descent…
  for (const lc of [0, 0.1, 0.2, 0.3, 0.39]) assert.equal(plateIsVisible(lc), true, `hidden mid-descent at ${lc}`);
  // …and the whole hold, which is when it is set down.
  for (const lc of [0.4, 0.5, 0.59]) assert.equal(plateIsVisible(lc), true, `hidden during the hold at ${lc}`);
  // It only goes once the hook is back up and the trolley has moved off.
  assert.equal(plateIsVisible(0.9), false);
  assert.ok(hiddenNow[0] >= 0.6, "the plate still disappears before the hook has risen");
});

test("the repair drone stays level and faces the break", () => {
  // What was reported: "дрон почему-то переворачивается … он же должен быть
  // горизонтально всегда". It was `lookAt` (which aims -Z at a target BELOW it,
  // so: pitched hard over) followed by `rotation.y += PI/2` — adding to the Y
  // of an already-pitched Euler, which recomposes as roll.
  //
  // The body is built along +X, and under Ry(a) local +X maps to
  // (cos a, 0, -sin a). This is that yaw, and nothing else.
  const yaw = (dx: number, dz: number) => Math.atan2(-dz, dx);
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-3, 2]]) {
    const a = yaw(dx, dz);
    const L = Math.hypot(dx, dz);
    assert.ok(Math.abs(Math.cos(a) - dx / L) < 1e-9, `+X.x wrong facing (${dx},${dz})`);
    assert.ok(Math.abs(-Math.sin(a) - dz / L) < 1e-9, `+X.z wrong facing (${dx},${dz})`);
  }
  // And the attitude carries no roll: rotation is set as (0, yaw, pitch), where
  // Euler XYZ applies the Z first — in the body frame, where it lowers the nose.
  // An X component would be roll, and there must not be one.
  assert.match(SRC, /drone\.rotation\.set\(0,Math\.atan2\(-dz,dx\),/);
  // The old formulation must be gone, both halves of it.
  assert.equal(/drone\.lookAt/.test(SRC), false, "the drone still uses lookAt");
  assert.equal(/drone\.rotation\.y\+=/.test(SRC), false, "the drone still adds to its Euler Y");
});
