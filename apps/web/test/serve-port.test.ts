import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePort, DEFAULT_PORT } from "../lib/lanes";
import { soleExposedPort } from "../lib/gcp-rest";
import { buildAppSpec } from "../lib/fleet-spec";

/**
 * The port an app is served on, which was 8080 at every site that needed one.
 *
 * That held while every image was one we generated a Dockerfile for — we write
 * `ENV PORT=8080` into those. It stopped holding the first time an author's own
 * image was placed: excalidraw's final stage is stock nginx, which serves 80 and
 * never reads $PORT. It came up, answered 200 on 80, was probed on 8080, and was
 * rolled back with "the fleet router answered, not the app".
 */

test("nothing said, nothing exposed — the platform default", () => {
  assert.equal(choosePort(undefined, null), DEFAULT_PORT);
});

test("the image's sole exposed port wins over the default", () => {
  // The excalidraw case exactly: no plan port, an image exposing 80.
  assert.equal(choosePort(undefined, 80), 80);
});

test("what the app declares outranks what the image exposes", () => {
  // The planner is asked for `port` precisely when an app hardcodes one instead
  // of reading $PORT, so it is a statement about behaviour; EXPOSE is a label.
  // A Node image that EXPOSEs 3000 while the app listens on 4000 is the case,
  // and it is why these are not the same evidence.
  assert.equal(choosePort(4000, 3000), 4000);
});

test("a plan port that is not a port is not believed", () => {
  // The planner is a model. Every one of these has to fall through to the next
  // kind of evidence rather than reach the spec as a port number.
  for (const junk of ["8080", 0, -1, 65536, 1.5, null, NaN, {}, [], true]) {
    assert.equal(choosePort(junk, 80), 80, `${JSON.stringify(junk)} should not be taken as a port`);
  }
});

test("one exposed port is an answer; two are not", () => {
  assert.equal(soleExposedPort({ "80/tcp": {} }), 80);
  // Two is an image that has not said which one serves HTTP. Guessing the lower
  // would be a coin toss with a number on it, and 8080 is the better fallback
  // because it is also what PORT is set to.
  assert.equal(soleExposedPort({ "80/tcp": {}, "443/tcp": {} }), null);
  assert.equal(soleExposedPort({}), null);
  assert.equal(soleExposedPort(undefined), null);
  assert.equal(soleExposedPort(null), null);
});

test("a udp port beside a tcp one does not make the image ambiguous", () => {
  // A log shipper exposing 514/udp has still said plainly which port serves.
  assert.equal(soleExposedPort({ "80/tcp": {}, "514/udp": {} }), 80);
  // But udp alone is not a web server.
  assert.equal(soleExposedPort({ "514/udp": {} }), null);
});

test("exposed-port shapes that are not ports", () => {
  assert.equal(soleExposedPort({ "0/tcp": {} }), null);
  assert.equal(soleExposedPort({ "70000/tcp": {} }), null);
  assert.equal(soleExposedPort({ "http/tcp": {} }), null);
  assert.equal(soleExposedPort({ "": {} }), null);
  assert.equal(soleExposedPort("80/tcp"), null);
});

test("the chosen port reaches the placement spec, and only there", () => {
  const spec = buildAppSpec({
    slug: "w", image: "img", env: [], secrets: [], processes: [], port: 80,
  });
  assert.equal(spec.port, 80);
  // Not duplicated onto the process. The agent prefers a process port over the
  // app's, so a copy here would be a second answer that outranks the real one —
  // which is how 8080 survived every deploy that resolved something else.
  assert.equal(spec.processes?.find((p) => p.kind === "web")?.port, undefined);
});

test("an app that says nothing still gets 8080 in the spec", () => {
  const spec = buildAppSpec({ slug: "w", image: "img", env: [], secrets: [], processes: [] });
  assert.equal(spec.port, DEFAULT_PORT);
});
