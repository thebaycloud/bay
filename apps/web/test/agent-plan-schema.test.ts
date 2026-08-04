import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLAN_SCHEMA, fromStructured } from "../lib/agents/plan-schema";

/**
 * The plan's shape is written twice — once as the `DeployPlan` interface, once
 * as a JSON Schema — because a model cannot be handed a TypeScript type. Two
 * declarations of one rule with nothing checking them is the defect
 * `DEPLOY-PLAN.md` is named about, so this reads the interface out of the source
 * and asserts the schema agrees.
 */

function interfaceFields(): { name: string; optional: boolean }[] {
  const src = readFileSync(resolve(import.meta.dirname, "..", "lib", "opencode-deploy.ts"), "utf8");
  const m = src.match(/export interface DeployPlan \{([\s\S]*?)\n\}/);
  assert.ok(m, "found the DeployPlan interface");
  return m![1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z]+\??:/.test(l))
    .map((l) => {
      const name = l.slice(0, l.indexOf(":")).replace("?", "");
      return { name, optional: l.includes("?:") };
    });
}

test("the schema describes exactly the fields DeployPlan has", () => {
  const fields = interfaceFields().map((f) => f.name).sort();
  const props = Object.keys(PLAN_SCHEMA.properties).sort();
  assert.deepEqual(props, fields,
    "a field added to DeployPlan must be added to PLAN_SCHEMA, or the planner can never return it");
});

test("every property is required, because OpenAI refuses otherwise", () => {
  // "Invalid schema for response_format: 'required' is required to be supplied
  // and to be an array including every key in properties."
  const props = Object.keys(PLAN_SCHEMA.properties).sort();
  assert.deepEqual([...PLAN_SCHEMA.required].sort(), props);
});

/**
 * Where the schema deliberately disagrees with the interface, and why.
 *
 * `run` — the interface calls it required, but a static site and a
 * container-built app both legitimately have none, and demanding one threw away
 * every correct plan for Go and Rust (`opencode-deploy.ts:578-587`).
 *
 * `static`, `needsDB` — optional on the interface, plain booleans here. Absent
 * and `false` mean the same thing for both, so a required boolean is strictly
 * MORE informative: it makes the model decide rather than letting it omit the
 * field and leave us guessing which it meant.
 */
const DELIBERATE: Record<string, "nullable-though-required" | "required-though-optional"> = {
  run: "nullable-though-required",
  static: "required-though-optional",
  needsDB: "required-though-optional",
};

test("optional fields are nullable, required ones are not", () => {
  for (const f of interfaceFields()) {
    const prop = (PLAN_SCHEMA.properties as Record<string, { type: unknown }>)[f.name];
    const nullable = Array.isArray(prop.type) && (prop.type as string[]).includes("null");
    const exception = DELIBERATE[f.name];

    if (exception) {
      // Assert the exception is the one we documented, so a field cannot drift
      // into disagreeing by accident and be waved through by this list.
      if (exception === "nullable-though-required") {
        assert.ok(!f.optional && nullable, `${f.name}: expected required-on-interface and nullable-in-schema`);
      } else {
        assert.ok(f.optional && !nullable, `${f.name}: expected optional-on-interface and non-nullable-in-schema`);
      }
      continue;
    }

    if (f.optional) {
      assert.ok(nullable, `${f.name} is optional on the interface, so it must be nullable in the schema`);
    } else {
      assert.ok(!nullable, `${f.name} is required on the interface, so it must not be nullable`);
    }
  }
});

test("nulls become absent fields, not literal nulls", () => {
  // The platform tests fields with `if (plan.build)` and `plan.outputDir ?? …`.
  // A literal null passes `"build" in plan` and fails everything after it.
  const plan = fromStructured({
    language: "node", install: "npm ci", build: null, run: "npm start",
    static: false, outputDir: null, needsDB: false, preRun: null,
    port: null, envNeeded: null, reason: "package.json with a start script",
  });
  assert.deepEqual(plan, {
    language: "node", install: "npm ci", run: "npm start",
    static: false, needsDB: false, reason: "package.json with a start script",
  });
  assert.ok(!("build" in plan!), "an absent field is absent, not null");
});

test("an empty array is as absent as null", () => {
  // `preRun: []` and no preRun mean the same thing; keeping the empty one makes
  // a plan look like it asked for steps it did not.
  const plan = fromStructured({ language: "node", preRun: [], envNeeded: ["DATABASE_URL"] });
  assert.ok(!("preRun" in plan!));
  assert.deepEqual(plan!.envNeeded, ["DATABASE_URL"]);
});

test("junk is refused rather than coerced", () => {
  assert.equal(fromStructured(null), null);
  assert.equal(fromStructured("a string"), null);
  assert.equal(fromStructured([1, 2]), null);
});
