import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStack, parse, describeDetection, type Detection, type AgentStack } from "../lib/detect-stack";

const stack = (over: Partial<AgentStack> = {}): AgentStack => ({
  language: "python", framework: "fastapi",
  installCommand: null, buildCommand: null, startCommand: "uvicorn app:app",
  serve: { mode: "container" },
  ...over,
} as AgentStack);

/* ── parsing what npm actually prints ─────────────────────────────────────── */

test("the JSON is found after whatever npm decided to say first", () => {
  // `npm run --silent` is quieter than `npm run`, not silent. A funding notice,
  // a deprecation warning or a lifecycle line can precede the output, and any of
  // them makes JSON.parse of the whole string throw on character 1. This is why
  // the slice exists, and it is the only thing here a test can pin — reproducing
  // npm's noise on demand is not something a test can arrange.
  const noisy = `npm warn config production Use --omit=dev instead.\n{"stack":{"language":"go"}}`;
  assert.equal(parse(noisy).stack.language, "go");
});

test("output with no JSON at all fails saying what was printed instead", () => {
  // The failure mode this replaces is `Unexpected token N in JSON at position 0`,
  // which names neither the detector nor what it said. A deploy stops here, so
  // the message is the only evidence anybody gets.
  assert.throws(() => parse("npm ERR! missing script: detect\n"),
    /detector printed no JSON[\s\S]*missing script/);
});

test("detectStack spawns nothing a test has to arrange, and asks for the API shape", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const capture = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return `{"stack":{"language":"node"},"provisionPlan":{"needsDB":true}}`;
  };

  const got = await detectStack("/tmp/app", capture, "apps/agent");

  assert.equal(got.stack.language, "node");
  assert.deepEqual(got.provisionPlan, { needsDB: true });
  // `--api` is what makes the agent answer JSON rather than prose. Without it
  // the parse above has nothing to find.
  assert.ok(calls[0].args.includes("--api"), "the detector must be asked for its machine answer");
  assert.ok(calls[0].args.includes("/tmp/app"), "…about the directory it was given");
});

/* ── what the user is told ────────────────────────────────────────────────── */

test("the headline names the framework, the language and how sure the detector is", () => {
  const lines = describeDetection({ stack: stack({ confidence: 0.87 }) } as Detection);
  assert.equal(lines[0], "Detected fastapi · python (87%)");
});

test("each provisioning promise appears only when there is one to make", () => {
  // Every line below commits the platform to creating something. A line missing
  // is a surprise later; a line appearing wrongly is a promise the deploy does
  // not keep. Both are why this is a pure function with a test per branch rather
  // than four `if (x) log(...)` in the middle of a deploy.
  const bare = describeDetection({ stack: stack({ confidence: 1 }) } as Detection);
  assert.equal(bare.length, 1, `expected only the headline, got: ${bare.join(" | ")}`);

  const full = describeDetection({
    stack: stack({
      confidence: 1,
      database: { engine: "postgres", via: "sqlalchemy" },
      cache: "redis",
      secretsNeeded: ["STRIPE_KEY", "SENTRY_DSN"],
    }),
  } as Detection);
  assert.deepEqual(full, [
    "Detected fastapi · python (100%)",
    "Provision postgres (via sqlalchemy)",
    "Provision redis cache",
    "Will ask for secrets: STRIPE_KEY, SENTRY_DSN",
  ]);
});

test("a database the detector names without an engine promises nothing", () => {
  // `database: { engine: null }` is the detector saying "there is talk of a
  // database here and I cannot tell which". Announcing "Provision null" would
  // read as a decision nobody made.
  const lines = describeDetection({
    stack: stack({ confidence: 1, database: { engine: null, via: "prisma" } }),
  } as Detection);
  assert.equal(lines.length, 1);
});

test("a missing confidence reads as zero rather than NaN", () => {
  // The agent owns this shape and does not have to answer every field. `NaN%`
  // in a user's deploy log is a bug report about the platform, not about a repo.
  const lines = describeDetection({ stack: stack() } as Detection);
  assert.match(lines[0], /\(0%\)$/);
});
