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
