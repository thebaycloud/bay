import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeFromClaims, identityVerdict, NODE_AUDIENCE } from "@/lib/node-identity";

const claims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: NODE_AUDIENCE,
  email: "540236122367-compute@developer.gserviceaccount.com",
  google: {
    compute_engine: {
      instance_name: "fleet-lab-1",
      instance_id: "6482570550078911325",
      project_id: "supersonic-deploy-prod",
      zone: "us-central1-a",
    },
  },
  ...over,
});

// THE WHOLE POINT. `FLEET_TOKEN` is one string shared by the fleet, so it proves
// "a node" and never "which node" — a compromised node can claim to be another
// and read the secrets of the apps placed there. An instance identity token is
// minted by the metadata server for one VM and says which one.
test("the instance name comes from the token, never from the request", () => {
  const n = nodeFromClaims(claims());
  assert.deepEqual(n, { node: "fleet-lab-1", instanceId: "6482570550078911325", zone: "us-central1-a" });
});

// `format=full` is what puts `compute_engine` in the payload at all. Without it
// the token is still valid and still signed by Google, and says nothing about
// which machine — which is exactly the property being bought here.
test("a token without the compute_engine block proves nothing and is refused", () => {
  assert.equal(nodeFromClaims(claims({ google: {} })), null);
  assert.equal(nodeFromClaims(claims({ google: undefined })), null);
});

// The audience is what stops a token minted for another service being replayed
// here. Google will happily issue one for any audience a caller asks for.
test("a token minted for someone else is refused", () => {
  assert.equal(nodeFromClaims(claims({ aud: "https://example.com/other" })), null);
});

// The project is checked because an instance in ANOTHER project can also ask
// Google for a token with our audience — the audience is a string, not a secret.
test("an instance in another project is refused", () => {
  const other = claims();
  (other.google as any).compute_engine.project_id = "someone-elses-project";
  assert.equal(nodeFromClaims(other), null);
});

// Google is the only issuer this accepts. Belt and braces: `jwtVerify` already
// checks the signature against Google's keys, and this makes the claim explicit
// so a future change of verifier cannot quietly widen it.
test("only Google's issuer is accepted", () => {
  assert.equal(nodeFromClaims(claims({ iss: "https://accounts.evil.example" })), null);
});

// HOW A SIGNED IDENTITY IS USED, which is a rollout decision as much as a
// security one. Nodes are updated on their own two-minute timer, so there is a
// window where some send the header and some do not, and refusing early would
// take the fleet's secrets away from every node that had not collected the new
// agent yet.
//
// Three states, and the middle one is the whole design:
//   audit    absent is fine, mismatched is refused
//   enforce  absent is refused too
test("a signed name that disagrees with the claimed one is refused in either mode", () => {
  const v = { node: "fleet-lab-1", instanceId: "1", zone: "z" };
  assert.equal(identityVerdict("fleet-lab-2", v, "audit").ok, false);
  assert.equal(identityVerdict("fleet-lab-2", v, "enforce").ok, false);
  assert.match(identityVerdict("fleet-lab-2", v, "audit").reason ?? "", /fleet-lab-1/);
});

test("a signed name that agrees is accepted", () => {
  const v = { node: "fleet-lab-1", instanceId: "1", zone: "z" };
  assert.equal(identityVerdict("fleet-lab-1", v, "audit").ok, true);
  assert.equal(identityVerdict("fleet-lab-1", v, "enforce").ok, true);
});

// The rollout window. An agent that has not been updated sends no header, and
// under `audit` it keeps working on the shared token exactly as before.
test("no identity is allowed while auditing and refused once enforcing", () => {
  assert.equal(identityVerdict("fleet-lab-1", null, "audit").ok, true);
  assert.equal(identityVerdict("fleet-lab-1", null, "audit").audited, true);
  assert.equal(identityVerdict("fleet-lab-1", null, "enforce").ok, false);
});

// A mismatch is never merely audited. Auditing is about tokens that are ABSENT,
// not about tokens that actively contradict the request — one is a node that has
// not been updated, the other is a node claiming to be a different node.
test("audit mode is about absence, never about contradiction", () => {
  const v = { node: "fleet-lab-3", instanceId: "9", zone: "z" };
  const r = identityVerdict("fleet-lab-1", v, "audit");
  assert.equal(r.ok, false);
  assert.equal(r.audited, false);
});
