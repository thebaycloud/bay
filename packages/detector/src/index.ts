/**
 * Deterministic stack detection and build planning.
 *
 * This is the reliable core the Gemini agent builds on: it reads a repo, figures
 * out what it is, what backend it needs, and how to containerize it. The LLM agent
 * handles the weird ~10% (odd monorepos, custom builds) and iterates to green;
 * this handles the other 90% instantly, with no tokens.
 *
 * Usage:  tsx src/index.ts <path-or-git-url> [--json] [--dockerfile]
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
// The versions the platform actually has. Imported, not restated: this file said
// `python:3.12` for as long as the runner shipped 3.14, and since `runtime` is
// what pythonDockerfile() turns into `FROM python:…-slim`, every repo declaring
// `requires-python = ">=3.14"` was built on the wrong interpreter and failed at
// pip. The constant lives in apps/web because that is the only one of the two
// directories the control-plane image carries that Next can also bundle; both are
// in the same image (root Dockerfile), so this path resolves in production too.
import { RUNTIME_VERSIONS } from "../../../apps/web/lib/plan-deps";

export type DbEngine = "postgres" | "mysql" | "mongodb" | "redis" | "sqlite" | null;

/**
 * How the deployed app is served.
 *
 * `static` means the build produces a directory of files and nothing needs to run
 * afterwards, so the deploy can skip building a container image entirely and just
 * upload `outputDir`. `container` means the app has a server that has to stay up.
 */
export type Serve =
  | { mode: "static"; outputDir: string }
  | { mode: "container" };

export interface Stack {
  language: string;
  framework: string;
  packageManager: string | null;
  runtime: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string;
  port: number;
  database: { engine: DbEngine; via: string | null };
  cache: DbEngine;
  secretsNeeded: string[];
  serve: Serve;
  confidence: number;
  notes: string[];
}

const CONTAINER: Serve = { mode: "container" };

/**
 * How to install dependencies.
 *
 * "npm" is the fallback when no lockfile of any kind was found — and `npm ci`
 * refuses to run without a package-lock.json. So the default branch was picking
 * the one command that cannot work in the case that reaches it. Every project
 * without a lockfile failed its first build and was rescued by the repair agent
 * running `npm install`, at the cost of a wasted build and about a minute on the
 * critical path. Measured on a real deploy: 93s to the failure, 158s to live.
 *
 * A lockfile-less project is the common case for the people this platform is for.
 */
export function installFor(pm: string, hasNpmLock: boolean): string {
  switch (pm) {
    case "pnpm": return "pnpm i --frozen-lockfile";
    case "yarn": return "yarn --frozen-lockfile";
    case "bun": return "bun install";
    default: return hasNpmLock ? "npm ci" : "npm install";
  }
}

/**
 * Astro builds a static site by default and a server bundle once an adapter is
 * configured, and the two need opposite deploy paths. The adapter is the signal:
 * `output` alone is not, because `output: 'server'` without an adapter is a
 * configuration error rather than a server build.
 */
export function astroServe(configSource: string | null): Serve {
  const src = configSource ?? "";
  const hasAdapter = /adapter\s*:/.test(src) || /@astrojs\/(node|vercel|netlify|cloudflare|deno)/.test(src);
  return hasAdapter ? CONTAINER : { mode: "static", outputDir: "dist" };
}

/**
 * Next.js only produces a static directory under `output: 'export'`. Anything else
 * — including the default — needs the Next server running.
 */
export function nextServe(configSource: string | null): Serve {
  const src = configSource ?? "";
  return /output\s*:\s*["'`]export["'`]/.test(src) ? { mode: "static", outputDir: "out" } : CONTAINER;
}

function read(dir: string, file: string): string | null {
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
function has(dir: string, file: string): boolean {
  return existsSync(join(dir, file));
}

const SDK_SECRETS: Record<string, string> = {
  stripe: "STRIPE_SECRET_KEY",
  openai: "OPENAI_API_KEY",
  "@anthropic-ai/sdk": "ANTHROPIC_API_KEY",
  "@google/generative-ai": "GEMINI_API_KEY",
  resend: "RESEND_API_KEY",
  "@sendgrid/mail": "SENDGRID_API_KEY",
  twilio: "TWILIO_AUTH_TOKEN",
  "aws-sdk": "AWS_ACCESS_KEY_ID",
};

// ---------------------------------------------------------------- detection

export function detectStack(dir: string): Stack {
  const notes: string[] = [];
  const pkg = read(dir, "package.json");
  if (pkg) return detectNode(dir, pkg, notes);
  if (has(dir, "requirements.txt") || has(dir, "pyproject.toml") || has(dir, "manage.py"))
    return detectPython(dir, notes);
  if (has(dir, "go.mod")) return detectGo(notes);
  if (has(dir, "Gemfile")) return detectRuby(dir, notes);
  if (has(dir, "composer.json")) return detectPhp(dir, notes);
  if (has(dir, "index.html")) return staticSite(notes);
  notes.push("No recognized manifest — treating as a static site.");
  return staticSite(notes);
}

function detectNode(dir: string, pkgRaw: string, notes: string[]): Stack {
  let pkg: any = {};
  try { pkg = JSON.parse(pkgRaw); } catch { notes.push("package.json is not valid JSON."); }
  const deps: Record<string, string> = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const dep = (n: string) => n in deps;

  const language = dep("typescript") || has(dir, "tsconfig.json") ? "TypeScript" : "JavaScript";
  const pm = has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : has(dir, "bun.lockb") ? "bun" : "npm";
  const installCommand = installFor(pm, has(dir, "package-lock.json"));

  let framework = "Node";
  let buildCommand: string | null = scripts.build ? `${pm} run build` : null;
  let startCommand = scripts.start ? `${pm} start` : "node index.js";
  let port = 3000;
  let serve: Serve = CONTAINER;

  if (dep("next")) { framework = "Next.js"; buildCommand = `${pm} run build`; startCommand = `${pm} start`; serve = nextServe(nextConfig(dir)); }
  else if (dep("@remix-run/node") || dep("@remix-run/react")) { framework = "Remix"; buildCommand = `${pm} run build`; startCommand = `${pm} start`; }
  else if (dep("nuxt")) { framework = "Nuxt"; buildCommand = `${pm} run build`; startCommand = "node .output/server/index.mjs"; }
  else if (dep("@sveltejs/kit")) { framework = "SvelteKit"; buildCommand = `${pm} run build`; startCommand = "node build"; }
  else if (dep("astro")) { framework = "Astro"; buildCommand = `${pm} run build`; startCommand = "node ./dist/server/entry.mjs"; port = 4321; serve = astroServe(astroConfig(dir)); }
  else if (dep("@nestjs/core")) { framework = "NestJS"; buildCommand = `${pm} run build`; startCommand = "node dist/main.js"; }
  else if (dep("vite")) { framework = "Vite (SPA)"; buildCommand = `${pm} run build`; startCommand = "(static)"; port = 80; serve = { mode: "static", outputDir: "dist" }; notes.push("SPA — served as static assets behind the CDN."); }
  else if (dep("react-scripts")) { framework = "Create React App"; buildCommand = `${pm} run build`; startCommand = "(static)"; port = 80; serve = { mode: "static", outputDir: "build" }; }
  else if (dep("express") || dep("fastify") || dep("koa")) { framework = dep("express") ? "Express" : dep("fastify") ? "Fastify" : "Koa"; }

  let engine: DbEngine = null; let via: string | null = null;
  if (dep("@prisma/client") || dep("prisma") || has(dir, "prisma/schema.prisma")) { via = "Prisma"; engine = prismaEngine(dir) ?? "postgres"; }
  else if (dep("drizzle-orm")) { via = "Drizzle"; engine = dep("mysql2") ? "mysql" : dep("better-sqlite3") ? "sqlite" : "postgres"; }
  else if (dep("mongoose")) { via = "Mongoose"; engine = "mongodb"; }
  else if (dep("typeorm")) { via = "TypeORM"; engine = dep("mysql2") || dep("mysql") ? "mysql" : "postgres"; }
  else if (dep("sequelize")) { via = "Sequelize"; engine = dep("mysql2") || dep("mysql") ? "mysql" : "postgres"; }
  else if (dep("pg") || dep("postgres")) { via = "pg"; engine = "postgres"; }
  else if (dep("mysql2") || dep("mysql")) { via = "mysql"; engine = "mysql"; }

  const cache: DbEngine = dep("redis") || dep("ioredis") ? "redis" : null;
  const secretsNeeded = Object.keys(SDK_SECRETS).filter(dep).map((k) => SDK_SECRETS[k]);
  const nodeMajor = pkg.engines?.node?.match(/\d+/)?.[0] ?? "22";

  return {
    language, framework, packageManager: pm, runtime: `node:${nodeMajor}`,
    installCommand, buildCommand, startCommand, port,
    database: { engine, via }, cache, secretsNeeded, serve,
    confidence: framework === "Node" ? 0.6 : 0.95, notes,
  };
}

/** Config files are read as text — we only ever pattern-match, never execute them. */
function nextConfig(dir: string): string | null {
  for (const f of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    const s = read(dir, f);
    if (s) return s;
  }
  return null;
}
function astroConfig(dir: string): string | null {
  for (const f of ["astro.config.mjs", "astro.config.js", "astro.config.ts"]) {
    const s = read(dir, f);
    if (s) return s;
  }
  return null;
}

function prismaEngine(dir: string): DbEngine {
  const s = read(dir, "prisma/schema.prisma");
  if (!s) return null;
  const p = s.match(/provider\s*=\s*"(\w+)"/)?.[1];
  return p === "postgresql" ? "postgres" : p === "mysql" ? "mysql" : p === "sqlite" ? "sqlite" : p === "mongodb" ? "mongodb" : "postgres";
}

function detectPython(dir: string, notes: string[]): Stack {
  const reqs = (read(dir, "requirements.txt") || "") + (read(dir, "pyproject.toml") || "");
  const m = (s: string) => new RegExp(s, "i").test(reqs);
  let framework = "Python"; let startCommand = "python app.py"; let port = 8000;
  if (has(dir, "manage.py") || m("django")) { framework = "Django"; startCommand = "gunicorn ${MODULE}.wsgi --bind 0.0.0.0:8000"; notes.push("Set ${MODULE} to your Django project package."); }
  else if (m("fastapi")) { framework = "FastAPI"; startCommand = "uvicorn main:app --host 0.0.0.0 --port 8000"; }
  else if (m("flask")) { framework = "Flask"; startCommand = "gunicorn app:app --bind 0.0.0.0:8000"; }

  let engine: DbEngine = null; let via: string | null = null;
  if (m("psycopg") || m("django")) { engine = "postgres"; via = m("psycopg") ? "psycopg" : "Django ORM"; }
  else if (m("sqlalchemy")) { engine = "postgres"; via = "SQLAlchemy"; }
  else if (m("pymysql") || m("mysqlclient")) { engine = "mysql"; via = "mysql"; }
  else if (m("pymongo")) { engine = "mongodb"; via = "pymongo"; }

  const cache: DbEngine = m("redis") ? "redis" : null;
  const secretsNeeded: string[] = [];
  if (m("openai")) secretsNeeded.push("OPENAI_API_KEY");
  if (m("stripe")) secretsNeeded.push("STRIPE_SECRET_KEY");

  return {
    language: "Python", framework, packageManager: "pip", runtime: `python:${RUNTIME_VERSIONS.python}`,
    installCommand: "pip install --no-cache-dir -r requirements.txt", buildCommand: null,
    startCommand, port, database: { engine, via }, cache, secretsNeeded, serve: CONTAINER,
    confidence: framework === "Python" ? 0.6 : 0.9, notes,
  };
}

function detectGo(notes: string[]): Stack {
  return { language: "Go", framework: "Go", packageManager: "go", runtime: "golang:1.22", installCommand: "go mod download", buildCommand: "go build -o server ./...", startCommand: "./server", port: 8080, database: { engine: null, via: null }, cache: null, secretsNeeded: [], serve: CONTAINER, confidence: 0.75, notes };
}
function detectRuby(dir: string, notes: string[]): Stack {
  const rails = (read(dir, "Gemfile") || "").match(/rails/i) != null;
  return { language: "Ruby", framework: rails ? "Rails" : "Ruby", packageManager: "bundler", runtime: "ruby:3.3", installCommand: "bundle install", buildCommand: rails ? "bundle exec rails assets:precompile" : null, startCommand: rails ? "bundle exec rails server -b 0.0.0.0" : "ruby app.rb", port: 3000, database: { engine: rails ? "postgres" : null, via: rails ? "ActiveRecord" : null }, cache: null, secretsNeeded: [], serve: CONTAINER, confidence: rails ? 0.9 : 0.6, notes };
}
function detectPhp(dir: string, notes: string[]): Stack {
  const laravel = (read(dir, "composer.json") || "").match(/laravel\/framework/i) != null;
  return { language: "PHP", framework: laravel ? "Laravel" : "PHP", packageManager: "composer", runtime: "php:8.3", installCommand: "composer install --no-dev", buildCommand: null, startCommand: laravel ? "php artisan serve --host 0.0.0.0 --port 8000" : "php -S 0.0.0.0:8000", port: 8000, database: { engine: laravel ? "mysql" : null, via: laravel ? "Eloquent" : null }, cache: null, secretsNeeded: [], serve: CONTAINER, confidence: laravel ? 0.9 : 0.6, notes };
}
function staticSite(notes: string[]): Stack {
  // Nothing to build: the directory we were handed is already the site, so the
  // release is uploaded from "." rather than from a build output directory.
  return { language: "Static", framework: "Static site", packageManager: null, runtime: "nginx", installCommand: null, buildCommand: null, startCommand: "(nginx)", port: 80, database: { engine: null, via: null }, cache: null, secretsNeeded: [], serve: { mode: "static", outputDir: "." }, confidence: 0.8, notes };
}

// ---------------------------------------------------------------- containerize

export function dockerfile(s: Stack): string {
  if (s.runtime.startsWith("node")) return nodeDockerfile(s);
  if (s.runtime.startsWith("python")) return pythonDockerfile(s);
  if (s.runtime === "nginx") return `FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n`;
  const v = s.runtime.split(":")[1] ?? "latest";
  const base = s.runtime.split(":")[0];
  return `FROM ${base}:${v}\nWORKDIR /app\nCOPY . .\n${s.installCommand ? `RUN ${s.installCommand}\n` : ""}${s.buildCommand ? `RUN ${s.buildCommand}\n` : ""}ENV PORT=${s.port}\nEXPOSE ${s.port}\nCMD ${s.startCommand}\n`;
}

function nodeDockerfile(s: Stack): string {
  const v = s.runtime.split(":")[1];
  return [
    `FROM node:${v}-slim AS deps`,
    `WORKDIR /app`,
    `COPY package*.json pnpm-lock.yaml* yarn.lock* ./`,
    `RUN ${s.installCommand}`,
    ``,
    `FROM node:${v}-slim AS build`,
    `WORKDIR /app`,
    `COPY --from=deps /app/node_modules ./node_modules`,
    `COPY . .`,
    s.buildCommand ? `RUN ${s.buildCommand}` : `# no build step`,
    ``,
    `FROM node:${v}-slim`,
    `WORKDIR /app`,
    `ENV NODE_ENV=production PORT=${s.port}`,
    `COPY --from=build /app ./`,
    `EXPOSE ${s.port}`,
    `CMD ["sh","-c","${s.startCommand}"]`,
    ``,
  ].join("\n");
}

function pythonDockerfile(s: Stack): string {
  const v = s.runtime.split(":")[1];
  return [
    `FROM python:${v}-slim`,
    `WORKDIR /app`,
    `COPY requirements.txt ./`,
    `RUN ${s.installCommand}`,
    `COPY . .`,
    `ENV PORT=${s.port}`,
    `EXPOSE ${s.port}`,
    `CMD ["sh","-c","${s.startCommand}"]`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------- provision plan

export function provisionPlan(s: Stack): string[] {
  const plan: string[] = [];
  if (s.database.engine) plan.push(`Provision ${s.database.engine} (detected via ${s.database.via})`);
  if (s.cache) plan.push(`Provision ${s.cache} cache`);
  plan.push("Wire managed auth (Identity Platform)");
  plan.push("Wire transactional email + object storage + CDN");
  plan.push("Embed analytics (PostHog)");
  plan.push("Apply security baseline (secret scan, rate limits, WAF)");
  plan.push("Enable daily backups");
  if (s.secretsNeeded.length) plan.push(`Ask user for secrets: ${s.secretsNeeded.join(", ")}`);
  plan.push(`Deploy to Cloud Run on :${s.port} → <slug>.thebay.cloud`);
  return plan;
}

// ---------------------------------------------------------------- CLI

function cloneToTemp(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ss-"));
  execSync(`git clone --depth 1 ${url} ${dir}`, { stdio: "pipe" });
  return dir;
}

function printSummary(stack: Stack): void {
  const line = "─".repeat(52);
  const db = stack.database.engine ? `${stack.database.engine} (${stack.database.via})` : "none";
  console.log(line);
  console.log(`  DETECTED   ${stack.framework}  ·  ${stack.language}  ·  ${Math.round(stack.confidence * 100)}% confidence`);
  console.log(line);
  console.log(`  runtime    ${stack.runtime}`);
  if (stack.packageManager) console.log(`  pkg mgr    ${stack.packageManager}`);
  if (stack.installCommand) console.log(`  install    ${stack.installCommand}`);
  if (stack.buildCommand) console.log(`  build      ${stack.buildCommand}`);
  console.log(`  start      ${stack.startCommand}`);
  console.log(`  port       ${stack.port}`);
  console.log(`  database   ${db}`);
  if (stack.cache) console.log(`  cache      ${stack.cache}`);
  console.log(`  secrets    ${stack.secretsNeeded.length ? stack.secretsNeeded.join(", ") : "none needed"}`);
  if (stack.notes.length) stack.notes.forEach((n) => console.log(`  note       ${n}`));
  console.log(line);
  console.log("  PROVISION PLAN");
  provisionPlan(stack).forEach((p, i) => console.log(`   ${String(i + 1).padStart(2, "0")}  ${p}`));
  console.log(line);
}

function main(): void {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--")) ?? ".";
  let dir = target;
  if (/^(https?:\/\/|git@)/.test(target)) {
    try { dir = cloneToTemp(target); } catch (e: any) { console.error(`Clone failed: ${e.message}`); process.exit(1); }
  }
  if (!existsSync(dir)) { console.error(`Path not found: ${dir}`); process.exit(1); }

  const stack = detectStack(dir);
  if (args.includes("--api")) { process.stdout.write(JSON.stringify({ stack, provisionPlan: provisionPlan(stack) })); return; }
  if (args.includes("--emit")) { process.stdout.write(dockerfile(stack)); return; }
  printSummary(stack);
  if (args.includes("--dockerfile")) { console.log("\nDockerfile\n" + "─".repeat(52) + "\n" + dockerfile(stack)); }
  if (args.includes("--json")) { console.log("\n" + JSON.stringify({ stack, dockerfile: dockerfile(stack), provisionPlan: provisionPlan(stack) }, null, 2)); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
