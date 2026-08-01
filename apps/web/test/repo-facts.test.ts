import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepoFacts, declaredLanguages, contradictions, normalizeLanguage, refusalReason } from "../lib/repo-facts";

/** Build a throwaway repo from a {path: contents} map. Directories are implied. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-facts-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

test("the FastAPI template declares Python at its root, and ships a Dockerfile one level down", () => {
  // This is the exact shape that deployed to the Node runner on 1 Aug: a root
  // package.json for the frontend tooling, a root pyproject.toml declaring a uv
  // workspace, and the author's own Dockerfile inside backend/. The detector saw
  // the first and called the repo "Node · JavaScript (60%)"; the other two were
  // never read.
  const dir = repo({
    "package.json": "{}",
    "pyproject.toml": "[tool.uv.workspace]\nmembers = [\"backend\"]\n",
    "uv.lock": "",
    "backend/Dockerfile": "FROM python:3.12\n",
    "backend/pyproject.toml": "[project]\nname = \"app\"\n",
    "frontend/package.json": "{}",
    "frontend/Dockerfile.playwright": "FROM node:24\n",
  });
  try {
    const facts = readRepoFacts(dir);
    const langs = declaredLanguages(facts);
    assert.ok(langs.includes("python"), "the repository declares Python");
    assert.ok(langs.includes("node"), "and Node — it is genuinely both");
    assert.deepEqual(facts.dockerfiles, ["backend/Dockerfile"]);
    // Dockerfile.playwright is tooling. Treating it as a deploy recipe would be
    // a guess, and guessing is the failure this module exists to prevent.
    assert.ok(!facts.dockerfiles.includes("frontend/Dockerfile.playwright"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a root declaration is marked as one, and shallower declarations come first", () => {
  const dir = repo({ "go.mod": "module x\n", "services/api/go.mod": "module y\n" });
  try {
    const facts = readRepoFacts(dir);
    assert.equal(facts.declarations[0].from, "go.mod");
    assert.equal(facts.declarations[0].root, true);
    assert.equal(facts.declarations[1].root, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node_modules does not turn every repository into a Node repository", () => {
  const dir = repo({
    "go.mod": "module x\n",
    "node_modules/lodash/package.json": "{}",
    "node_modules/.bin/x": "",
  });
  try {
    assert.deepEqual(declaredLanguages(readRepoFacts(dir)), ["go"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dangling symlink is skipped rather than followed", () => {
  // The FastAPI template ships four of these, into a .venv that a fresh clone
  // does not have. Following them is how the source upload used to crash.
  const dir = repo({ "pyproject.toml": "" });
  mkdirSync(join(dir, ".agents/skills"), { recursive: true });
  symlinkSync("../../.venv/lib/python3.14/site-packages/fastapi", join(dir, ".agents/skills/fastapi"));
  try {
    const facts = readRepoFacts(dir);
    assert.deepEqual(declaredLanguages(facts), ["python"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a guess the repository never mentions is a contradiction", () => {
  const dir = repo({ "pyproject.toml": "", "backend/requirements.txt": "" });
  try {
    const facts = readRepoFacts(dir);
    const bad = contradictions(facts, "nodejs20");
    assert.ok(bad.length > 0, "Node contradicts a repo that only declares Python");
    assert.equal(contradictions(facts, "python3.12").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a polyglot repository contradicts neither of the languages it declares", () => {
  // A Next frontend beside a FastAPI backend genuinely is both. Picking either is
  // defensible; the pipeline must not treat this shape as an error.
  const dir = repo({ "package.json": "{}", "pyproject.toml": "" });
  try {
    const facts = readRepoFacts(dir);
    assert.equal(contradictions(facts, "nodejs20").length, 0);
    assert.equal(contradictions(facts, "python3.12").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("silence is not disagreement", () => {
  // A repository that declares nothing — a folder of HTML, say — contradicts
  // nothing. Refusing to deploy it would break the simplest case there is.
  const dir = repo({ "index.html": "<h1>hi</h1>" });
  try {
    assert.equal(contradictions(readRepoFacts(dir), "nodejs20").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unrecognised runtime has no opinion, rather than disagreeing with everything", () => {
  const dir = repo({ "pyproject.toml": "" });
  try {
    assert.equal(contradictions(readRepoFacts(dir), "elixir1.16").length, 0);
    assert.equal(normalizeLanguage("elixir1.16"), null);
    assert.equal(normalizeLanguage(""), null);
    assert.equal(normalizeLanguage("nodejs22"), "node");
    assert.equal(normalizeLanguage("python3.14"), "python");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable directory contributes nothing instead of failing the deploy", () => {
  assert.deepEqual(readRepoFacts(join(tmpdir(), "definitely-not-here-9c3f")), {
    declarations: [],
    dockerfiles: [],
  });
});

test("a repo declaring two languages is refused rather than half-deployed", () => {
  // y7ux3, 1 Aug: root package.json (frontend tooling) + root pyproject.toml
  // (uv workspace) + backend/Dockerfile. Node was picked, npm start was invented,
  // and the deploy died 27 minutes later at 503.
  const dir = repo({
    "package.json": "{}",
    "pyproject.toml": "",
    "backend/Dockerfile": "FROM python:3.12\n",
  });
  try {
    const why = refusalReason(readRepoFacts(dir), "nodejs20", "supersonic.json");
    assert.ok(why, "must refuse");
    assert.match(why!, /node and python|python and node/);
    // The refusal has to name the next action, and the best one available here is
    // the Dockerfile the author already wrote.
    assert.match(why!, /backend\/Dockerfile/);
    assert.match(why!, /supersonic\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ordinary single-language app is not refused", () => {
  // The common case must stay untouched: one manifest, one plausible answer,
  // and taking it is not a guess in any meaningful sense.
  const dir = repo({ "package.json": "{}", "index.js": "" });
  try {
    assert.equal(refusalReason(readRepoFacts(dir), "nodejs20", "supersonic.json"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare folder of HTML is not refused", () => {
  const dir = repo({ "index.html": "<h1>hi</h1>" });
  try {
    assert.equal(refusalReason(readRepoFacts(dir), "nodejs20", "supersonic.json"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a guess the repo flatly contradicts is refused even with one language", () => {
  const dir = repo({ "go.mod": "module x\n" });
  try {
    const why = refusalReason(readRepoFacts(dir), "nodejs20", "supersonic.json");
    assert.ok(why);
    assert.match(why!, /--run|supersonic\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refusal names a Dockerfile when there is one, and a config when there is not", () => {
  const withDocker = repo({ "go.mod": "module x\n", "Dockerfile": "FROM golang\n" });
  const without = repo({ "go.mod": "module x\n" });
  try {
    assert.match(refusalReason(readRepoFacts(withDocker), "nodejs20", "supersonic.json")!, /Dockerfile/);
    assert.match(refusalReason(readRepoFacts(without), "nodejs20", "supersonic.json")!, /--run/);
  } finally {
    rmSync(withDocker, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
  }
});
