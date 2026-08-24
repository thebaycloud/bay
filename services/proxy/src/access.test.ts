import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAccess, domainOf, type AccessInput } from "./access";

/**
 * decideAccess with the two domain-rule answers defaulted to "no rule, nothing
 * proven", so every test that is not about domains reads as it did before them.
 */
function allows(i: Omit<AccessInput, "domainRuleMatches" | "visitorEmailVerified"> &
  Partial<Pick<AccessInput, "domainRuleMatches" | "visitorEmailVerified">>): boolean {
  return decideAccess({ domainRuleMatches: false, visitorEmailVerified: false, ...i });
}

const app = {
  id: "app-1",
  owner_id: "user-owner",
  workspace_id: "ws-acme",
  visibility: "private" as const,
};
const owner = { userId: "user-owner", email: "anna@acme.com" };
const colleague = { userId: "user-dana", email: "dana@acme.com" };
const outsider = { userId: "user-eve", email: "eve@other.com" };

test("owner can always open their own private app", () => {
  assert.equal(allows({ app, visitor: owner, visitorWorkspaceId: "ws-acme", hasGrant: false }), true);
});

test("colleague cannot open a private app", () => {
  assert.equal(allows({ app, visitor: colleague, visitorWorkspaceId: "ws-acme", hasGrant: false }), false);
});

test("colleague in the same workspace can open a workspace app", () => {
  assert.equal(allows({
    app: { ...app, visibility: "workspace" }, visitor: colleague,
    visitorWorkspaceId: "ws-acme", hasGrant: false,
  }), true);
});

test("outsider cannot open a workspace app", () => {
  assert.equal(allows({
    app: { ...app, visibility: "workspace" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: false,
  }), false);
});

test("granted email can open a shared app", () => {
  assert.equal(allows({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: true,
  }), true);
});

test("ungranted email cannot open a shared app", () => {
  assert.equal(allows({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: "ws-other", hasGrant: false,
  }), false);
});

test("a null visitor workspace never matches a workspace app", () => {
  assert.equal(allows({
    app: { ...app, visibility: "workspace" }, visitor: colleague,
    visitorWorkspaceId: null, hasGrant: false,
  }), false);
});

test("workspace visibility does not imply grant access for a different workspace", () => {
  assert.equal(allows({
    app: { ...app, visibility: "workspace" }, visitor: outsider,
    visitorWorkspaceId: null, hasGrant: true,
  }), false);
});

// An unrecognized visibility must deny. Without this the default branch — the
// whole point of deny-by-default — is unpinned, and a future edit could turn a
// typo or a new enum value into an open door.
test("an unrecognized visibility denies everyone", () => {
  for (const visibility of ["", "deleted", "PRIVATE"]) {
    assert.equal(allows({
      app: { ...app, visibility: visibility as never }, visitor: colleague,
      visitorWorkspaceId: "ws-acme", hasGrant: true,
    }), false, `visibility ${JSON.stringify(visibility)} should deny`);
  }
});

test("public visibility lets anyone in", () => {
  for (const visitor of [colleague, outsider]) {
    assert.equal(allows({
      app: { ...app, visibility: "public" }, visitor,
      visitorWorkspaceId: null, hasGrant: false,
    }), true);
  }
});

// The owner short-circuit is checked for private above; pin it for the other
// two so a refactor cannot reorder it away unnoticed.
test("the owner can open their app at every visibility", () => {
  for (const visibility of ["private", "shared", "workspace"] as const) {
    assert.equal(allows({
      app: { ...app, visibility }, visitor: owner,
      visitorWorkspaceId: null, hasGrant: false,
    }), true, `owner should open a ${visibility} app`);
  }
});

// Access by ORGANISATION: the app admits a domain rather than a list of people.

test("a verified address at a granted domain opens a shared app", () => {
  assert.equal(allows({
    app: { ...app, visibility: "shared" }, visitor: colleague,
    visitorWorkspaceId: "ws-acme", hasGrant: false,
    domainRuleMatches: true, visitorEmailVerified: true,
  }), true);
});

// The failure this pins: signup with a password asks for an address and never
// checks it. If an unproven address satisfied a domain rule, anyone could type
// dana@acme.com into our own signup form and walk into every app acme shares
// with its own staff — the rule would be `public` wearing a domain.
test("an unverified address at a granted domain is refused", () => {
  assert.equal(allows({
    app: { ...app, visibility: "shared" }, visitor: colleague,
    visitorWorkspaceId: "ws-acme", hasGrant: false,
    domainRuleMatches: true, visitorEmailVerified: false,
  }), false);
});

// Being invited BY NAME is unaffected by verification: the owner typed that
// address themselves, so there is nothing for us to prove about it.
test("a named invitation still opens the app without a verified address", () => {
  assert.equal(allows({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: null, hasGrant: true,
    domainRuleMatches: false, visitorEmailVerified: false,
  }), true);
});

test("a verified address with no matching rule is still refused", () => {
  assert.equal(allows({
    app: { ...app, visibility: "shared" }, visitor: outsider,
    visitorWorkspaceId: null, hasGrant: false,
    domainRuleMatches: false, visitorEmailVerified: true,
  }), false);
});

// A domain rule belongs to `shared` alone. On a private app it must be inert,
// or archiving an app by setting it private would leave a door open.
test("a domain rule does not open a private app", () => {
  assert.equal(allows({
    app: { ...app, visibility: "private" }, visitor: colleague,
    visitorWorkspaceId: "ws-acme", hasGrant: false,
    domainRuleMatches: true, visitorEmailVerified: true,
  }), false);
});

test("domainOf takes the domain half, lowercased", () => {
  assert.equal(domainOf("Dana@Acme.COM"), "acme.com");
});

// The one that matters: mail for this address routes to evil.com, and reading
// the last field would hand it a rule written for acme.com.
test("domainOf refuses an address with two @", () => {
  assert.equal(domainOf("dana@acme.com@evil.com"), "");
});

test("domainOf refuses what is not a deliverable domain", () => {
  for (const bad of ["", "dana", "dana@", "@acme.com", "dana@acme", "dana@.com", "dana@acme."]) {
    assert.equal(domainOf(bad), "", `${JSON.stringify(bad)} is not a domain`);
  }
});
