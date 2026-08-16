import { test } from "node:test";
import assert from "node:assert/strict";
import { maySeeSecrets, ownedBy, type PlacementRow } from "@/lib/secret-broker";

const NOW = 1_000_000_000_000;
const at = (slug: string, node: string, leaseMsFromNow: number): PlacementRow =>
  ({ slug, node, leaseUntil: NOW + leaseMsFromNow });

// The whole point of the broker, in one assertion. Today the node's service
// account holds `secretmanager.secretAccessor` project-wide and unconditioned,
// so one escape from one sandbox reads EVERY tenant's database password. The
// broker replaces "this identity may read secrets" with "this node may read the
// secrets of the apps currently placed on it".
test("a node may read for an app placed on it", () => {
  assert.deepEqual(maySeeSecrets([at("shop", "n1", 60_000)], { node: "n1", slug: "shop" }, NOW),
    { ok: true });
});

test("a node may not read for an app placed somewhere else", () => {
  const r = maySeeSecrets([at("shop", "n2", 60_000)], { node: "n1", slug: "shop" }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not placed/i);
});

test("an app nobody has been given is refused, not defaulted to yes", () => {
  assert.equal(maySeeSecrets([], { node: "n1", slug: "shop" }, NOW).ok, false);
});

// §8 makes the lease an AUTHORISATION primitive: "a node that lost its lease
// cannot fetch secrets, which is exactly the wanted behaviour". Note this does
// not contradict §5, where expiry authorises the control plane to RE-PLACE and
// is not an instruction to the node to stop: a running process keeps its already
// resolved environment. What expiry stops is a fresh START.
test("an expired lease reads nothing, and says that is why", () => {
  const r = maySeeSecrets([at("shop", "n1", -1)], { node: "n1", slug: "shop" }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /lease/i);
});

// Two replicas of one app on two nodes: each may read for itself. A rule written
// as "the app's placement" rather than "a placement of the app on this node"
// would let either node's answer authorise the other.
test("one app on two nodes authorises each node for itself only", () => {
  const rows = [at("shop", "n1", 60_000), at("shop", "n2", 60_000)];
  assert.equal(maySeeSecrets(rows, { node: "n1", slug: "shop" }, NOW).ok, true);
  assert.equal(maySeeSecrets(rows, { node: "n2", slug: "shop" }, NOW).ok, true);
  assert.equal(maySeeSecrets(rows, { node: "n3", slug: "shop" }, NOW).ok, false);
});

// A live placement of a DIFFERENT app on this node must not carry over. This is
// the blast radius: without it, a node legitimately holding one app could read
// the secrets of every app it has ever been asked about.
test("holding one app is not authority over another", () => {
  const r = maySeeSecrets([at("blog", "n1", 60_000)], { node: "n1", slug: "shop" }, NOW);
  assert.equal(r.ok, false);
});

// AUTHORISED FOR ONE APP IS NOT AUTHORISED FOR ONE APP'S NAME-SPACE ONLY BY
// CONVENTION. Placement answers "may this node act for `shop`"; it says nothing
// about which secret ids the request then lists. Without a second check, a node
// legitimately holding `shop` asks for `app-blog-DATABASE_URL` and the broker —
// having said ok — fetches it with the control plane's own credentials, which
// are broader than the node's ever were. That is not a smaller blast radius
// than today's; it is a larger one with an audit trail.
test("a node may only name secrets belonging to the app it is authorised for", () => {
  assert.equal(ownedBy("shop", "app-shop-DATABASE_URL"), true);
  assert.equal(ownedBy("shop", "app-blog-DATABASE_URL"), false);
});

// `app-shop-x` must not authorise `app-shopfront-x`. A plain `startsWith` on
// `app-${slug}` does exactly that, and slugs are user-chosen, so a tenant can
// pick the prefix of another tenant's slug on purpose.
test("a slug that is a prefix of another slug is not a way in", () => {
  assert.equal(ownedBy("shop", "app-shopfront-DATABASE_URL"), false);
  assert.equal(ownedBy("shopfront", "app-shop-DATABASE_URL"), false);
});

// The platform's own secrets are not app secrets and no node may name one.
test("nothing outside an app's own namespace is reachable", () => {
  assert.equal(ownedBy("shop", "fleet-edge-secret"), false);
  assert.equal(ownedBy("shop", "shop-DATABASE_URL"), false, "the app- prefix is required");
  assert.equal(ownedBy("shop", "../fleet-edge-secret"), false);
  assert.equal(ownedBy("shop", "app-shop-"), false, "a name needs a key");
});
