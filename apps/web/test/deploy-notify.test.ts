import { test } from "node:test";
import assert from "node:assert/strict";
import { deployEmail } from "../lib/deploy-notify";

test("a deploy that is still running sends nothing", () => {
  // The hook that calls this runs on every exit from the pipeline, including
  // ones that are not an ending. Deciding here keeps that call site free of the
  // question.
  assert.equal(deployEmail({ slug: "abc12", status: "building" }), null);
});

test("a failure names the app and carries the reason", () => {
  const m = deployEmail({
    slug: "abc12",
    name: "tasks",
    status: "failed",
    error: "npm start → Missing script \"start\"",
  })!;

  assert.match(m.subject, /tasks/);
  assert.match(m.text, /Missing script/);
});

test("a clean success gives the address and nothing alarming", () => {
  const m = deployEmail({ slug: "abc12", name: "tasks", status: "live" })!;

  assert.match(m.text, /abc12\.supersonic\.cv/);
  assert.doesNotMatch(m.subject, /not|fail/i);
});

test("a deploy whose sibling never came up does not report plain success", () => {
  // The failure mode found in production: the frontend is live on the app's own
  // address, every /api request falls through to it, and nothing is red. An
  // email saying "your app is live" is the last place that lie could be caught.
  const m = deployEmail({
    slug: "abc12",
    name: "tasks",
    status: "live",
    stage: "1 service(s) not served — /api: Deploying backend failed: probe timed out",
  })!;

  assert.doesNotMatch(m.subject, /^✓/);
  assert.match(m.subject, /part|partly|not all/i);
  assert.match(m.text, /\/api/);
});

test("a connection string in the reason never reaches the mailbox", () => {
  // Deploy errors quote whatever the tool said, and email leaves our systems —
  // it is retained, forwarded and searched by people who are not the operator.
  const m = deployEmail({
    slug: "abc12",
    status: "failed",
    error: "could not connect to postgresql://app:s3cret@10.1.2.3:5432/db",
  })!;

  assert.doesNotMatch(m.text, /s3cret/);
  assert.doesNotMatch(m.text, /postgresql:\/\//);
});
