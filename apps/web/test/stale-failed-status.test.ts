import { test } from "node:test";
import assert from "node:assert/strict";
import { clearsFailedStatus } from "../lib/fleet";
import type { ProcessState } from "../lib/fleet";

/**
 * A `failed` row that outlives the failure.
 *
 * `a8ebb` is marked `failed` in the apps table and has been for days. It serves
 * fine on the fleet — four processes, web and worker both up — and the dashboard
 * shows it as down, because `ready` on the list is `status === 'live'` and
 * nothing ever cleared the flag.
 *
 * The flag was written by a deploy that really did fail: its Cloud Run revision
 * could not start. Then the app moved to the fleet and started working, and no
 * code path exists that says so. 21 of 83 apps carry `failed` today; an unknown
 * number of them are, like this one, running.
 *
 * The node's report is the ground truth and it already arrives every few
 * seconds. If a node says it is running a process for an app, that app is not
 * failed — whatever a deploy concluded earlier.
 */

const IMG = "us-central1-docker.pkg.dev/p/r/a8ebb:latest";

test("a node running a healthy web process clears the flag", () => {
  const running: ProcessState[] = [{ slug: "a8ebb", process: "web", image: IMG, healthy: true }];
  assert.equal(clearsFailedStatus(running), true);
});

test("a node running only a worker clears it too", () => {
  // A worker has no port, so `healthy` is ABSENT — nobody asked. Requiring a
  // probe here would leave every worker-only app marked failed forever, which
  // is the same mistake in a new place.
  const running: ProcessState[] = [{ slug: "sxou5", process: "bot", image: IMG }];
  assert.equal(clearsFailedStatus(running), true);
});

test("a web process the node cannot reach does NOT clear it", () => {
  // Explicit false is the one real failure signal. An app whose web process is
  // up but answering nothing is not a working app, and saying so would hide a
  // genuine outage behind a green dot.
  const running: ProcessState[] = [{ slug: "a8ebb", process: "web", image: IMG, healthy: false }];
  assert.equal(clearsFailedStatus(running), false);
});

test("one silent web process spoils an otherwise running app", () => {
  const running: ProcessState[] = [
    { slug: "a8ebb", process: "ticker", image: IMG },
    { slug: "a8ebb", process: "web", image: IMG, healthy: false },
  ];
  assert.equal(clearsFailedStatus(running), false);
});

test("reporting nothing changes nothing", () => {
  // An empty report is what a node sends for an app it has just been given, and
  // what it sends while draining. Neither is evidence the app recovered.
  assert.equal(clearsFailedStatus([]), false);
});
