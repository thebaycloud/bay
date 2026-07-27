import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAccess } from "./access";

const app = {
  id: "app-1",
  owner_id: "user-owner",
  workspace_id: "ws-acme",
  visibility: "private" as const,
};
const owner = { userId: "user-owner", email: "anna@acme.com" };
const colleague = { userId: "user-boris", email: "boris@acme.com" };
const outsider = { userId: "user-eve", email: "eve@other.com" };

test("owner can always open their own private app", () => {
  assert.equal(decideAccess({ app, visitor: owner, visitorWorkspaceId: "ws-acme", hasGrant: false }), true);
});

test("colleague cannot open a private app", () => {
  assert.equal(decideAccess({ app, visitor: colleague, visitorWorkspaceId: "ws-acme", hasGrant: false }), false);
});

test("colleague in the same workspace can open a workspace app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: colleague,
    visitorWorkspaceId: "ws-acme", hasGrant: false,
  }), true);
});

test("outsider cannot open a workspace app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: false,
  }), false);
});

test("granted email can open a shared app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: true,
  }), true);
});

test("ungranted email cannot open a shared app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: false,
  }), false);
});

test("a null visitor workspace never matches a workspace app", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: colleague,
    visitorWorkspaceId: null, hasGrant: false,
  }), false);
});

test("workspace visibility does not imply grant access for a different workspace", () => {
  assert.equal(decideAccess({
    app: { ...app, visibility: "workspace" }, visitor: outsider,
    visitorWorkspaceId: null, hasGrant: true,
  }), false);
});

// An unrecognized visibility must deny. Without this the default branch — the
// whole point of deny-by-default — is unpinned, and a future edit could turn a
// typo or a new enum value into an open door.
test("an unrecognized visibility denies everyone", () => {
  for (const visibility of ["", "deleted", "PRIVATE"]) {
    assert.equal(decideAccess({
      app: { ...app, visibility: visibility as never }, visitor: colleague,
      visitorWorkspaceId: "ws-acme", hasGrant: true,
    }), false, `visibility ${JSON.stringify(visibility)} should deny`);
  }
});

test("public visibility lets anyone in", () => {
  for (const visitor of [colleague, outsider]) {
    assert.equal(decideAccess({
      app: { ...app, visibility: "public" }, visitor,
      visitorWorkspaceId: null, hasGrant: false,
    }), true);
  }
});

// The owner short-circuit is checked for private above; pin it for the other
// two so a refactor cannot reorder it away unnoticed.
test("the owner can open their app at every visibility", () => {
  for (const visibility of ["private", "shared", "workspace"] as const) {
    assert.equal(decideAccess({
      app: { ...app, visibility }, visitor: owner,
      visitorWorkspaceId: null, hasGrant: false,
    }), true, `owner should open a ${visibility} app`);
  }
});
