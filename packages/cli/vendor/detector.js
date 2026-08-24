// supersonic-vendor-stamp 90d7b95c32307760
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  astroServe: () => astroServe,
  detectStack: () => detectStack,
  dockerfile: () => dockerfile,
  installFor: () => installFor,
  nextServe: () => nextServe,
  provisionPlan: () => provisionPlan
});
module.exports = __toCommonJS(index_exports);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var import_node_child_process = require("node:child_process");
var import_node_url = require("node:url");

// ../../apps/web/lib/plan-deps.ts
var RUNTIME_VERSIONS = { python: "3.14", node: "24" };

// src/index.ts
var import_meta = {};
var CONTAINER = { mode: "container" };
function installFor(pm, hasNpmLock) {
  switch (pm) {
    case "pnpm":
      return "pnpm i --frozen-lockfile";
    case "yarn":
      return "yarn --frozen-lockfile";
    case "bun":
      return "bun install";
    default:
      return hasNpmLock ? "npm ci" : "npm install";
  }
}
function astroServe(configSource) {
  const src = configSource ?? "";
  const hasAdapter = /adapter\s*:/.test(src) || /@astrojs\/(node|vercel|netlify|cloudflare|deno)/.test(src);
  return hasAdapter ? CONTAINER : { mode: "static", outputDir: "dist" };
}
function nextServe(configSource) {
  const src = configSource ?? "";
  return /output\s*:\s*["'`]export["'`]/.test(src) ? { mode: "static", outputDir: "out" } : CONTAINER;
}
function read(dir, file) {
  const p = (0, import_node_path.join)(dir, file);
  return (0, import_node_fs.existsSync)(p) ? (0, import_node_fs.readFileSync)(p, "utf8") : null;
}
function has(dir, file) {
  return (0, import_node_fs.existsSync)((0, import_node_path.join)(dir, file));
}
var SDK_SECRETS = {
  stripe: "STRIPE_SECRET_KEY",
  openai: "OPENAI_API_KEY",
  "@anthropic-ai/sdk": "ANTHROPIC_API_KEY",
  "@google/generative-ai": "GEMINI_API_KEY",
  resend: "RESEND_API_KEY",
  "@sendgrid/mail": "SENDGRID_API_KEY",
  twilio: "TWILIO_AUTH_TOKEN",
  "aws-sdk": "AWS_ACCESS_KEY_ID"
};
function detectStack(dir) {
  const notes = [];
  const pkg = read(dir, "package.json");
  if (pkg) return detectNode(dir, pkg, notes);
  if (has(dir, "requirements.txt") || has(dir, "pyproject.toml") || has(dir, "manage.py"))
    return detectPython(dir, notes);
  if (has(dir, "go.mod")) return detectGo(notes);
  if (has(dir, "Gemfile")) return detectRuby(dir, notes);
  if (has(dir, "composer.json")) return detectPhp(dir, notes);
  if (has(dir, "index.html")) return staticSite(notes);
  notes.push("No recognized manifest \u2014 treating as a static site.");
  return staticSite(notes);
}
function detectNode(dir, pkgRaw, notes) {
  let pkg = {};
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    notes.push("package.json is not valid JSON.");
  }
  const deps = { ...pkg.dependencies || {}, ...pkg.devDependencies || {} };
  const scripts = pkg.scripts || {};
  const dep = (n) => n in deps;
  const language = dep("typescript") || has(dir, "tsconfig.json") ? "TypeScript" : "JavaScript";
  const pm = has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : has(dir, "bun.lockb") ? "bun" : "npm";
  const installCommand = installFor(pm, has(dir, "package-lock.json"));
  let framework = "Node";
  let buildCommand = scripts.build ? `${pm} run build` : null;
  let startCommand = scripts.start ? `${pm} start` : "node index.js";
  let port = 3e3;
  let serve = CONTAINER;
  if (dep("next")) {
    framework = "Next.js";
    buildCommand = `${pm} run build`;
    startCommand = `${pm} start`;
    serve = nextServe(nextConfig(dir));
  } else if (dep("@remix-run/node") || dep("@remix-run/react")) {
    framework = "Remix";
    buildCommand = `${pm} run build`;
    startCommand = `${pm} start`;
  } else if (dep("nuxt")) {
    framework = "Nuxt";
    buildCommand = `${pm} run build`;
    startCommand = "node .output/server/index.mjs";
  } else if (dep("@sveltejs/kit")) {
    framework = "SvelteKit";
    buildCommand = `${pm} run build`;
    startCommand = "node build";
  } else if (dep("astro")) {
    framework = "Astro";
    buildCommand = `${pm} run build`;
    startCommand = "node ./dist/server/entry.mjs";
    port = 4321;
    serve = astroServe(astroConfig(dir));
  } else if (dep("@nestjs/core")) {
    framework = "NestJS";
    buildCommand = `${pm} run build`;
    startCommand = "node dist/main.js";
  } else if (dep("vite")) {
    framework = "Vite (SPA)";
    buildCommand = `${pm} run build`;
    startCommand = "(static)";
    port = 80;
    serve = { mode: "static", outputDir: "dist" };
    notes.push("SPA \u2014 served as static assets behind the CDN.");
  } else if (dep("react-scripts")) {
    framework = "Create React App";
    buildCommand = `${pm} run build`;
    startCommand = "(static)";
    port = 80;
    serve = { mode: "static", outputDir: "build" };
  } else if (dep("express") || dep("fastify") || dep("koa")) {
    framework = dep("express") ? "Express" : dep("fastify") ? "Fastify" : "Koa";
  }
  let engine = null;
  let via = null;
  if (dep("@prisma/client") || dep("prisma") || has(dir, "prisma/schema.prisma")) {
    via = "Prisma";
    engine = prismaEngine(dir) ?? "postgres";
  } else if (dep("drizzle-orm")) {
    via = "Drizzle";
    engine = dep("mysql2") ? "mysql" : dep("better-sqlite3") ? "sqlite" : "postgres";
  } else if (dep("mongoose")) {
    via = "Mongoose";
    engine = "mongodb";
  } else if (dep("typeorm")) {
    via = "TypeORM";
    engine = dep("mysql2") || dep("mysql") ? "mysql" : "postgres";
  } else if (dep("sequelize")) {
    via = "Sequelize";
    engine = dep("mysql2") || dep("mysql") ? "mysql" : "postgres";
  } else if (dep("pg") || dep("postgres")) {
    via = "pg";
    engine = "postgres";
  } else if (dep("mysql2") || dep("mysql")) {
    via = "mysql";
    engine = "mysql";
  }
  const cache = dep("redis") || dep("ioredis") ? "redis" : null;
  const secretsNeeded = Object.keys(SDK_SECRETS).filter(dep).map((k) => SDK_SECRETS[k]);
  const nodeMajor = pkg.engines?.node?.match(/\d+/)?.[0] ?? "22";
  return {
    language,
    framework,
    packageManager: pm,
    runtime: `node:${nodeMajor}`,
    installCommand,
    buildCommand,
    startCommand,
    port,
    database: { engine, via },
    cache,
    secretsNeeded,
    serve,
    confidence: framework === "Node" ? 0.6 : 0.95,
    notes
  };
}
function nextConfig(dir) {
  for (const f of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    const s = read(dir, f);
    if (s) return s;
  }
  return null;
}
function astroConfig(dir) {
  for (const f of ["astro.config.mjs", "astro.config.js", "astro.config.ts"]) {
    const s = read(dir, f);
    if (s) return s;
  }
  return null;
}
function prismaEngine(dir) {
  const s = read(dir, "prisma/schema.prisma");
  if (!s) return null;
  const p = s.match(/provider\s*=\s*"(\w+)"/)?.[1];
  return p === "postgresql" ? "postgres" : p === "mysql" ? "mysql" : p === "sqlite" ? "sqlite" : p === "mongodb" ? "mongodb" : "postgres";
}
function detectPython(dir, notes) {
  const reqs = (read(dir, "requirements.txt") || "") + (read(dir, "pyproject.toml") || "");
  const m = (s) => new RegExp(s, "i").test(reqs);
  let framework = "Python";
  let startCommand = "python app.py";
  let port = 8e3;
  if (has(dir, "manage.py") || m("django")) {
    framework = "Django";
    startCommand = "gunicorn ${MODULE}.wsgi --bind 0.0.0.0:8000";
    notes.push("Set ${MODULE} to your Django project package.");
  } else if (m("fastapi")) {
    framework = "FastAPI";
    startCommand = "uvicorn main:app --host 0.0.0.0 --port 8000";
  } else if (m("flask")) {
    framework = "Flask";
    startCommand = "gunicorn app:app --bind 0.0.0.0:8000";
  }
  let engine = null;
  let via = null;
  if (m("psycopg") || m("django")) {
    engine = "postgres";
    via = m("psycopg") ? "psycopg" : "Django ORM";
  } else if (m("sqlalchemy")) {
    engine = "postgres";
    via = "SQLAlchemy";
  } else if (m("pymysql") || m("mysqlclient")) {
    engine = "mysql";
    via = "mysql";
  } else if (m("pymongo")) {
    engine = "mongodb";
    via = "pymongo";
  }
  const cache = m("redis") ? "redis" : null;
  const secretsNeeded = [];
  if (m("openai")) secretsNeeded.push("OPENAI_API_KEY");
  if (m("stripe")) secretsNeeded.push("STRIPE_SECRET_KEY");
  return {
    language: "Python",
    framework,
    packageManager: "pip",
    runtime: `python:${RUNTIME_VERSIONS.python}`,
    installCommand: "pip install --no-cache-dir -r requirements.txt",
    buildCommand: null,
    startCommand,
    port,
    database: { engine, via },
    cache,
    secretsNeeded,
    serve: CONTAINER,
    confidence: framework === "Python" ? 0.6 : 0.9,
    notes
  };
}
function detectGo(notes) {
  return { language: "Go", framework: "Go", packageManager: "go", runtime: "golang:1.22", installCommand: "go mod download", buildCommand: "go build -o server ./...", startCommand: "./server", port: 8080, database: { engine: null, via: null }, cache: null, secretsNeeded: [], serve: CONTAINER, confidence: 0.75, notes };
}
function detectRuby(dir, notes) {
  const rails = (read(dir, "Gemfile") || "").match(/rails/i) != null;
  return { language: "Ruby", framework: rails ? "Rails" : "Ruby", packageManager: "bundler", runtime: "ruby:3.3", installCommand: "bundle install", buildCommand: rails ? "bundle exec rails assets:precompile" : null, startCommand: rails ? "bundle exec rails server -b 0.0.0.0" : "ruby app.rb", port: 3e3, database: { engine: rails ? "postgres" : null, via: rails ? "ActiveRecord" : null }, cache: null, secretsNeeded: [], serve: CONTAINER, confidence: rails ? 0.9 : 0.6, notes };
}
function detectPhp(dir, notes) {
  const laravel = (read(dir, "composer.json") || "").match(/laravel\/framework/i) != null;
  return { language: "PHP", framework: laravel ? "Laravel" : "PHP", packageManager: "composer", runtime: "php:8.3", installCommand: "composer install --no-dev", buildCommand: null, startCommand: laravel ? "php artisan serve --host 0.0.0.0 --port 8000" : "php -S 0.0.0.0:8000", port: 8e3, database: { engine: laravel ? "mysql" : null, via: laravel ? "Eloquent" : null }, cache: null, secretsNeeded: [], serve: CONTAINER, confidence: laravel ? 0.9 : 0.6, notes };
}
function staticSite(notes) {
  return { language: "Static", framework: "Static site", packageManager: null, runtime: "nginx", installCommand: null, buildCommand: null, startCommand: "(nginx)", port: 80, database: { engine: null, via: null }, cache: null, secretsNeeded: [], serve: { mode: "static", outputDir: "." }, confidence: 0.8, notes };
}
function dockerfile(s) {
  if (s.runtime.startsWith("node")) return nodeDockerfile(s);
  if (s.runtime.startsWith("python")) return pythonDockerfile(s);
  if (s.runtime === "nginx") return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
  const v = s.runtime.split(":")[1] ?? "latest";
  const base = s.runtime.split(":")[0];
  return `FROM ${base}:${v}
WORKDIR /app
COPY . .
${s.installCommand ? `RUN ${s.installCommand}
` : ""}${s.buildCommand ? `RUN ${s.buildCommand}
` : ""}ENV PORT=${s.port}
EXPOSE ${s.port}
CMD ${s.startCommand}
`;
}
function nodeDockerfile(s) {
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
    ``
  ].join("\n");
}
function pythonDockerfile(s) {
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
    ``
  ].join("\n");
}
function provisionPlan(s) {
  const plan = [];
  if (s.database.engine) plan.push(`Provision ${s.database.engine} (detected via ${s.database.via})`);
  if (s.cache) plan.push(`Provision ${s.cache} cache`);
  plan.push("Wire managed auth (Identity Platform)");
  plan.push("Wire transactional email + object storage + CDN");
  plan.push("Embed analytics (PostHog)");
  plan.push("Apply security baseline (secret scan, rate limits, WAF)");
  plan.push("Enable daily backups");
  if (s.secretsNeeded.length) plan.push(`Ask user for secrets: ${s.secretsNeeded.join(", ")}`);
  plan.push(`Deploy to Cloud Run on :${s.port} \u2192 <slug>.thebay.cloud`);
  return plan;
}
function cloneToTemp(url) {
  const dir = (0, import_node_fs.mkdtempSync)((0, import_node_path.join)((0, import_node_os.tmpdir)(), "ss-"));
  (0, import_node_child_process.execSync)(`git clone --depth 1 ${url} ${dir}`, { stdio: "pipe" });
  return dir;
}
function printSummary(stack) {
  const line = "\u2500".repeat(52);
  const db = stack.database.engine ? `${stack.database.engine} (${stack.database.via})` : "none";
  console.log(line);
  console.log(`  DETECTED   ${stack.framework}  \xB7  ${stack.language}  \xB7  ${Math.round(stack.confidence * 100)}% confidence`);
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
function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--")) ?? ".";
  let dir = target;
  if (/^(https?:\/\/|git@)/.test(target)) {
    try {
      dir = cloneToTemp(target);
    } catch (e) {
      console.error(`Clone failed: ${e.message}`);
      process.exit(1);
    }
  }
  if (!(0, import_node_fs.existsSync)(dir)) {
    console.error(`Path not found: ${dir}`);
    process.exit(1);
  }
  const stack = detectStack(dir);
  if (args.includes("--api")) {
    process.stdout.write(JSON.stringify({ stack, provisionPlan: provisionPlan(stack) }));
    return;
  }
  if (args.includes("--emit")) {
    process.stdout.write(dockerfile(stack));
    return;
  }
  printSummary(stack);
  if (args.includes("--dockerfile")) {
    console.log("\nDockerfile\n" + "\u2500".repeat(52) + "\n" + dockerfile(stack));
  }
  if (args.includes("--json")) {
    console.log("\n" + JSON.stringify({ stack, dockerfile: dockerfile(stack), provisionPlan: provisionPlan(stack) }, null, 2));
  }
}
if (import_meta.url === (0, import_node_url.pathToFileURL)(process.argv[1] ?? "").href) main();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  astroServe,
  detectStack,
  dockerfile,
  installFor,
  nextServe,
  provisionPlan
});
