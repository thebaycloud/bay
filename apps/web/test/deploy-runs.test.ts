import { test } from "node:test";
import assert from "node:assert/strict";
import { assertJobImageMatches } from "../lib/deploy-runs";

test("dispatch is allowed when the job and the service run the same tag", async () => {
  await assert.doesNotReject(() => assertJobImageMatches("supersonic-deploy-job", {
    jobImage: async () => "reg/supersonic/control-plane:abc123",
    serviceImage: async () => "reg/supersonic/control-plane:abc123",
  }));
});

test("dispatch is refused when the job is on an older tag", async () => {
  // cloudbuild.yaml's job step ends in `|| echo`, so a failed job update never
  // fails the build. The job is then left on the previous commit's pipeline
  // while the service moves — every deploy runs code nobody thinks is running.
  await assert.rejects(
    () => assertJobImageMatches("supersonic-deploy-job", {
      jobImage: async () => "reg/supersonic/control-plane:old111",
      serviceImage: async () => "reg/supersonic/control-plane:new222",
    }),
    /old111.*new222|new222.*old111/,
  );
});

test("dispatch is refused when either image carries no tag", async () => {
  // Two untagged references both read as "" and would compare equal, which is
  // the one case where equality is not evidence of agreement.
  await assert.rejects(
    () => assertJobImageMatches("supersonic-deploy-job", {
      jobImage: async () => "reg/supersonic/control-plane",
      serviceImage: async () => "reg/supersonic/control-plane",
    }),
    /untagged/,
  );
});

test("a probe that cannot answer does not block the deploy", async () => {
  // The check exists to catch a stale image, not to become a new way for every
  // deploy to fail. An API that is down must cost the check, not the deploy.
  await assert.doesNotReject(() => assertJobImageMatches("supersonic-deploy-job", {
    jobImage: async () => { throw new Error("500 from Cloud Run"); },
    serviceImage: async () => "reg/supersonic/control-plane:abc123",
  }));
});

test("SKIP_JOB_IMAGE_CHECK=1 turns the refusal off without a deploy", async () => {
  // A guard that can refuse every deploy needs a way to be switched off that is
  // faster than shipping a revert — the same shape BUILDER already uses, and the
  // reason cloudbuild.yaml keeps its lane flags as variables.
  process.env.SKIP_JOB_IMAGE_CHECK = "1";
  try {
    await assert.doesNotReject(() => assertJobImageMatches("supersonic-deploy-job", {
      jobImage: async () => "reg/supersonic/control-plane:old111",
      serviceImage: async () => "reg/supersonic/control-plane:new222",
    }));
  } finally {
    delete process.env.SKIP_JOB_IMAGE_CHECK;
  }
});
