import { test } from "node:test";
import assert from "node:assert/strict";
import { redeployableRepo } from "../lib/repo-source";

test("a git deploy stores the repository it came from", () => {
  // The whole point of the column. `apps` has never had one — lib/adopt.ts opens
  // by saying so — and the consequence is stated there too: "there is nothing to
  // redeploy FROM", which is why twenty apps had to be ADOPTED by their running
  // image rather than rebuilt.
  assert.equal(
    redeployableRepo({ url: "https://github.com/acme/api", isUpload: false }),
    "https://github.com/acme/api",
  );
  assert.equal(
    redeployableRepo({ url: "https://gitlab.com/acme/api.git", isUpload: false }),
    "https://gitlab.com/acme/api.git",
  );
});

test("an upload stores nothing, because there is nothing to clone", () => {
  // On the upload path `url` is a reference to the tarball in GCS, not a
  // repository. Storing it would be worse than storing nothing: the column would
  // be populated, every reader would believe it, and the redeploy it promises
  // would fail on an object that the deploy already consumed.
  assert.equal(redeployableRepo({ url: "gs://supersonic-src/abc123.tgz", isUpload: true }), null);
  assert.equal(redeployableRepo({ url: "", isUpload: true }), null);
});

test("only something clonable is stored, whatever the caller claims", () => {
  // `isUpload` comes from a request header, so it is a claim rather than a fact.
  // The shape of the value is checked independently — a bucket reference is not
  // a repository however the request was labelled.
  assert.equal(redeployableRepo({ url: "gs://supersonic-src/abc123.tgz", isUpload: false }), null);
  assert.equal(redeployableRepo({ url: "/Users/someone/code/api", isUpload: false }), null);
  assert.equal(redeployableRepo({ url: "   ", isUpload: false }), null);
  // ssh remotes are clonable, and the platform has no key for them — so they are
  // stored as the honest record of where the app came from, and the redeploy that
  // reads this has to say "I cannot reach that" rather than silently not having it.
  assert.equal(
    redeployableRepo({ url: "git@github.com:acme/api.git", isUpload: false }),
    "git@github.com:acme/api.git",
  );
});

test("a stored value is never overwritten with nothing", () => {
  // A redeploy from an upload must not erase the repository an earlier git deploy
  // recorded. `null` means "leave what is there", which is what the SQL below
  // relies on — the column is only assigned when this returns a string.
  assert.equal(redeployableRepo({ url: "", isUpload: false }), null);
});
