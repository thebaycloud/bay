import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeatSql } from "@/lib/fleet";

test("the heartbeat carries the agent version", () => {
  const q = heartbeatSql({
    name: "n1", zone: "us-central1-a", internalIp: "10.0.0.1",
    memoryBytes: 1, cpus: 2, agentVersion: "abc1234",
  });
  assert.ok(q.text.includes("agent_version"));
  assert.equal(q.values[5], "abc1234");
});

// An older agent sends nothing, and nothing must not be read as a version.
// Overwriting a stored version with null on every heartbeat from a not-yet-
// updated node would make a rolling update look like a fleet-wide regression.
test("an agent that does not report leaves the stored version alone", () => {
  const q = heartbeatSql({
    name: "n1", zone: "us-central1-a", internalIp: "10.0.0.1",
    memoryBytes: 1, cpus: 2,
  });
  assert.equal(q.values[5], null);
  assert.ok(
    /agent_version = COALESCE\(EXCLUDED\.agent_version, fleet_nodes\.agent_version\)/.test(q.text),
    "an absent version must not clear the stored one",
  );
});
