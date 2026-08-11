import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideSync } from "@/lib/fleet";

// An agent built before this field existed sends nothing, and must keep working
// exactly as it did. Silence is not "I am up to date" — it is "I do not speak
// this", and reading it as the former would leave such a node holding whatever
// it had at the moment it was upgraded past.
test("an agent that does not send a generation always gets the full set", () => {
  assert.deepEqual(decideSync(undefined, 7), { send: true, generation: 7 });
  assert.deepEqual(decideSync(null, 7), { send: true, generation: 7 });
  assert.deepEqual(decideSync(NaN, 7), { send: true, generation: 7 });
});

test("a node already at the current generation is told nothing changed", () => {
  assert.deepEqual(decideSync(7, 7), { send: false, generation: 7 });
});

test("a node behind the current generation gets the full set", () => {
  assert.deepEqual(decideSync(6, 7), { send: true, generation: 7 });
});

// A node whose stored generation is somehow AHEAD of ours — a database restored
// from a backup, a node that talked to a different control plane — must be
// corrected rather than left silent forever. Anything that is not an exact match
// sends.
test("a node ahead of us is corrected, not left waiting", () => {
  assert.deepEqual(decideSync(9, 7), { send: true, generation: 7 });
});

// The ordering rule this whole mechanism rests on, asserted against the source
// because it cannot be observed from outside: the handler must read the
// generation BEFORE it reads the desired state.
//
// Read in that order, a write landing in between gives the node newer data
// carrying an older generation — it refetches next poll and gets the same thing,
// which is harmless. Read the other way round, the node gets older data carrying
// a newer generation, stops asking, and is stale until something else changes.
// One of those orderings is a missed deploy and the other is a wasted request.
test("the sync route reads the generation before the desired state", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../app/api/fleet/sync/route.ts"), "utf8");
  const gen = src.indexOf("fleetGeneration(");
  const desired = src.indexOf("desiredFor(");
  assert.ok(gen > 0, "the route must read the generation");
  assert.ok(desired > 0, "the route must read the desired state");
  assert.ok(gen < desired, "the generation must be read first — see this test's comment");
});

test("the migration keeps the counter to a single row", () => {
  const sql = readFileSync(resolve(import.meta.dirname, "../db/023_fleet_generation.sql"), "utf8");
  assert.ok(/CHECK \(only_row\)/.test(sql), "a second row would make 'the' generation ambiguous");
  assert.ok(/ON CONFLICT \(only_row\) DO NOTHING/.test(sql), "the migration must be idempotent");
});
