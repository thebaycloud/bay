/**
 * `DeployPlan` as a JSON Schema, for backends that can constrain the model's
 * final answer to a shape.
 *
 * STRICT, and it has to be. OpenAI structured outputs refuse a schema whose
 * `required` does not list every key in `properties`:
 *
 *   Invalid schema for response_format 'codex_output_schema': 'required' is
 *   required to be supplied and to be an array including every key in
 *   properties. Missing 'install'.
 *
 * So optionality is expressed as a NULLABLE TYPE, never as an absent entry, and
 * `fromStructured` below turns the nulls back into absent fields — because
 * `DeployPlan` uses `?:` and a literal `null` would satisfy neither the type nor
 * the code that reads it.
 *
 * This file is the one place the plan's shape is written twice (once as a TS
 * interface, once as a schema), so `test/agent-plan-schema.test.ts` asserts the
 * two agree. Two declarations of one rule with nothing checking them is the
 * defect `DEPLOY-PLAN.md` is named after.
 */

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "language", "install", "build", "run", "static", "outputDir",
    "needsDB", "preRun", "port", "envNeeded", "reason",
  ],
  properties: {
    language: { type: "string", enum: ["node", "python", "static", "other"] },
    install: { type: ["string", "null"], description: "Override the default install step." },
    build: { type: ["string", "null"], description: "Build step, or null for none." },
    run: {
      type: ["string", "null"],
      description: "Production run command. MUST bind 0.0.0.0 on $PORT for server apps. Null only for static sites and for apps built as containers.",
    },
    static: { type: "boolean", description: "Serve built assets statically, with no server process." },
    outputDir: { type: ["string", "null"], description: "Static only: the built directory, e.g. dist, out, build." },
    needsDB: { type: "boolean", description: "Provision Postgres and inject DATABASE_URL." },
    preRun: {
      type: ["array", "null"],
      items: { type: "string" },
      description: "One-shot steps before serving, e.g. migrations.",
    },
    port: { type: ["integer", "null"], description: "Only if the app hardcodes a port instead of reading $PORT." },
    envNeeded: {
      type: ["array", "null"],
      items: { type: "string" },
      description: "Names of environment variables the app reads. Names only, never values.",
    },
    reason: { type: ["string", "null"], description: "One line: how you read the stack." },
  },
} as const;

/**
 * Turn a schema-shaped answer into a `DeployPlan`.
 *
 * Nulls become absent keys. The schema must return every field, and the rest of
 * the platform tests fields with `?.` and `if (plan.build)` — a literal null
 * would pass `"build" in plan` and fail everything after it.
 */
export function fromStructured(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null) continue;
    // An empty array is as absent as null here: `preRun: []` and no preRun mean
    // the same thing, and carrying the empty one makes a plan look like it asked
    // for steps it did not.
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}
