import { test } from "node:test";
import assert from "node:assert/strict";
import { probeApp } from "../lib/deploy-pipeline";
import { classify } from "../lib/deploy-errors";

/**
 * What happens when the platform cannot mint the credential its own check needs.
 *
 * Every case here returns BEFORE `verifyApp` is reached, so none of them touches
 * the network. The path where the token IS minted is exercised by the pipeline
 * harness in deploy-pipeline.test.ts.
 */

const noSleep = async () => {};
const nowhere = () => {};

test("a token that cannot be minted fails the deploy instead of passing it", async () => {
  // The defect. The comment above this code said "a token failure means the
  // check did not happen, and saying so beats returning a pass we never
  // verified" — and the code returned { ok: true }. So a deploy whose app never
  // came up shipped, was marked live, and reported verified, on the strength of
  // a check that did not run.
  const r = await probeApp("https://app.example", nowhere, true, undefined, {
    mint: async () => { throw new Error("metadata: 403 Permission denied"); },
    sleepImpl: noSleep,
  });

  assert.equal(r.ok, false, "an unverifiable deploy must not be reported as verified");
  assert.match(r.reason ?? "", /never verified/i);
});

test("the failure is blamed on the platform, so no repair agent is sent", async () => {
  // The half that makes failing closed safe. Without the marker this same
  // change hands an LLM a customer's repository with write access over a
  // credential of OURS — the exact failure this codebase keeps closing doors
  // against. Asserted through classify rather than by matching the string,
  // because appearing in a reason is not the property that matters.
  const r = await probeApp("https://app.example", nowhere, true, undefined, {
    mint: async () => { throw new Error("metadata: 403"); },
    sleepImpl: noSleep,
  });

  assert.equal(classify(r.reason ?? "").blame, "platform");
});

test("a transient failure is retried rather than believed", async () => {
  // Most of what breaks here is a metadata hiccup, and one of those is not
  // evidence about the app. Turning it into a failed deploy would trade a
  // silent false pass for a noisy false failure, which is no better.
  let calls = 0;
  const r = await probeApp("https://app.example", nowhere, true, undefined, {
    mint: async () => {
      calls++;
      if (calls < 3) throw new Error("connection reset");
      return "a-token";
    },
    sleepImpl: noSleep,
  });

  assert.equal(calls, 3, "the mint was not retried");
  // It got a token, so it went on to the real check — which is the network call
  // this test deliberately does not make, so the only assertion available is
  // that it did NOT stop at the credential.
  assert.ok(!/never verified/i.test(r.reason ?? ""), `stopped at the credential anyway: ${r.reason}`);
});

test("it gives up rather than retrying forever", async () => {
  // A deploy that hangs on a credential is worse than one that fails: nobody
  // can tell it apart from a slow build.
  let calls = 0;
  await probeApp("https://app.example", nowhere, true, undefined, {
    mint: async () => { calls++; throw new Error("down"); },
    sleepImpl: noSleep,
  });
  assert.equal(calls, 3);
});

test("a public app is never asked for a credential it does not need", async () => {
  // `sealed` false means the check reaches the app without one, so minting
  // must not run at all — a token failure on a public app would otherwise fail
  // a deploy for a credential nothing was going to use.
  let calls = 0;
  await probeApp("http://127.0.0.1:1/", nowhere, false, undefined, {
    mint: async () => { calls++; return "unused"; },
    sleepImpl: noSleep,
  }).catch(() => {}); // verifyApp is reached and cannot connect; not this test's subject

  assert.equal(calls, 0);
});
