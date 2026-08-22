import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneTokenFor } from "../lib/github-clone";

/**
 * Whether this caller may clone through this installation.
 *
 * One function rather than one per caller. `/api/detect` wants a URL and the
 * deploy pipeline wants a token, but the question in front of both is
 * identical, and a check written twice is a check that will disagree with
 * itself eventually. The pipeline is the reason it cannot live in a route at
 * all: `runDeploy` is reached from the request handler, the worker and the job,
 * so a check inside one of them is a check two callers never make.
 *
 * The assertion that matters in every case below is `minted` — refusing after
 * minting would already have handed a credential to code that was not allowed
 * one.
 */

const W = "11111111-1111-1111-1111-111111111111";

test("no installation means no token, and nothing is minted", async () => {
  let minted = false;
  const token = await cloneTokenFor({
    workspaceId: W, installationId: null,
    owns: async () => true,
    mint: async () => { minted = true; return "x"; },
  });
  assert.equal(token, undefined);
  assert.equal(minted, false);
});

test("an owned installation yields a token", async () => {
  const token = await cloneTokenFor({
    workspaceId: W, installationId: 155650459,
    owns: async () => true,
    mint: async () => "ghs_minted",
  });
  assert.equal(token, "ghs_minted");
});

test("an installation the workspace does not own mints nothing and throws", async () => {
  let minted = false;
  await assert.rejects(
    () => cloneTokenFor({
      workspaceId: W, installationId: 999,
      owns: async () => false,
      mint: async () => { minted = true; return "x"; },
    }),
    /not connected/,
  );
  assert.equal(minted, false, "minted for an installation the workspace does not own");
});

test("an installation with no workspace behind it is refused", async () => {
  // A caller that could not resolve a workspace must not fall through to
  // "allowed": on the deploy path ownerWorkspace is legitimately null for some
  // callers, and null must mean no, never skip-the-check.
  let minted = false;
  await assert.rejects(
    () => cloneTokenFor({
      workspaceId: null, installationId: 1,
      owns: async () => true,
      mint: async () => { minted = true; return "x"; },
    }),
    /not connected/,
  );
  assert.equal(minted, false);
});

test("the ownership question is asked with exactly what it was given", async () => {
  const asked: Array<[string, number]> = [];
  await cloneTokenFor({
    workspaceId: W, installationId: 42,
    owns: async (w, i) => { asked.push([w, i]); return true; },
    mint: async () => "t",
  });
  assert.deepEqual(asked, [[W, 42]]);
});

test("a token is scrubbed out of anything git said", async () => {
  const { redactToken } = await import("../lib/github-clone");
  const said = "fatal: Authentication failed for 'https://x-access-token:ghs_secret@github.com/o/r.git/'";
  const clean = redactToken(said, "ghs_secret");
  assert.ok(!clean.includes("ghs_secret"), clean);
  assert.match(clean, /github\.com\/o\/r\.git/, "the repository should still be identifiable");
});

test("scrubbing without a token changes nothing", async () => {
  const { redactToken } = await import("../lib/github-clone");
  const said = "fatal: repository not found";
  assert.equal(redactToken(said, undefined), said);
});

test("every occurrence goes, not just the first", async () => {
  const { redactToken } = await import("../lib/github-clone");
  const clean = redactToken("t0k and again t0k", "t0k");
  assert.ok(!clean.includes("t0k"), clean);
});

test("an installation nobody named is no installation, however it arrived", async () => {
  // undefined is how "not named" reaches this from a jsonb run row written
  // before the field existed, and from any caller that simply omits it. A
  // strict null check turned all of those into "not connected to your
  // workspace" — a refusal aimed at a person who named nothing, and it broke
  // 26 deploy-pipeline tests before it would have broken every upload deploy.
  let minted = false;
  const token = await cloneTokenFor({
    workspaceId: null,
    installationId: undefined as unknown as null,
    owns: async () => false,
    mint: async () => { minted = true; return "x"; },
  });
  assert.equal(token, undefined);
  assert.equal(minted, false);
});
