// supersonic-vendor-stamp 74a44af20cb8d43b
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

// ../../packages/cli/src/resolver.entry.ts
var resolver_entry_exports = {};
__export(resolver_entry_exports, {
  CONFIG_FILENAME: () => CONFIG_FILENAME,
  ConfigError: () => ConfigError,
  DEFAULT_SCALE: () => DEFAULT_SCALE,
  RUNTIME_UNSUPPORTED: () => RUNTIME_UNSUPPORTED,
  RUNTIME_VERSIONS: () => RUNTIME_VERSIONS,
  ResolveError: () => ResolveError,
  appResources: () => appResources,
  assertConsumed: () => assertConsumed,
  bindToPort: () => bindToPort,
  declaredLanguages: () => declaredLanguages,
  deployableParts: () => deployableParts,
  deriveLane: () => deriveLane,
  inferAppConfig: () => inferAppConfig,
  isDeployablePart: () => isDeployablePart,
  missingSecrets: () => missingSecrets,
  normalizeLanguage: () => normalizeLanguage,
  parseAppConfig: () => parseAppConfig,
  platformOwned: () => platformOwned,
  primaryService: () => primaryService,
  pythonInstall: () => pythonInstall,
  pythonModule: () => pythonModule,
  readAppConfig: () => readAppConfig,
  readRepoFacts: () => readRepoFacts,
  resolve: () => resolve,
  runtimeMismatch: () => runtimeMismatch,
  serviceFor: () => serviceFor,
  servicePath: () => servicePath,
  validate: () => validate
});
module.exports = __toCommonJS(resolver_entry_exports);

// lib/resolve.ts
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");

// lib/app-config.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// lib/lanes.ts
var DB_HOST = "127.0.0.1";
var DB_PORT = "5432";
var CLOUD_SQL_PROXY_IMAGE = process.env.CLOUD_SQL_PROXY_IMAGE ?? "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1";
function databaseEnv(db) {
  return [
    `DATABASE_URL=${db.databaseUrl}`,
    `POSTGRES_SERVER=${DB_HOST}`,
    `POSTGRES_HOST=${DB_HOST}`,
    `POSTGRES_PORT=${DB_PORT}`,
    `POSTGRES_USER=${db.user}`,
    `POSTGRES_PASSWORD=${db.password}`,
    `POSTGRES_DB=${db.dbName}`,
    `PGHOST=${DB_HOST}`,
    `PGPORT=${DB_PORT}`,
    `PGUSER=${db.user}`,
    `PGPASSWORD=${db.password}`,
    `PGDATABASE=${db.dbName}`,
    `DB_HOST=${DB_HOST}`,
    `DB_PORT=${DB_PORT}`,
    `DB_USER=${db.user}`,
    `DB_PASSWORD=${db.password}`,
    `DB_NAME=${db.dbName}`
  ];
}
function databaseEnvNames() {
  return databaseEnv({ databaseUrl: "", user: "", password: "", dbName: "" }).map((pair) => pair.slice(0, pair.indexOf("=")));
}
var DEFAULT_SCALE = {
  memory: process.env.RUNNER_MEMORY || "2Gi",
  cpu: 1,
  maxInstances: 10,
  timeout: 900,
  concurrency: 80,
  cpuBoost: true
};
function withScale(over) {
  return { ...DEFAULT_SCALE, ...over ?? {} };
}

// lib/app-config.ts
var CONFIG_FILENAME = "supersonic.json";
var ConfigError = class extends Error {
};
var LANGUAGES = /* @__PURE__ */ new Set(["node", "python", "static", "other"]);
var PLATFORM_OWNED_PREFIXES = [/^POSTGRES_/, /^PG/, /^DB_/, /^SUPERSONIC_/];
var PLATFORM_OWNED_EXACT = /* @__PURE__ */ new Set([...databaseEnvNames(), "PORT"]);
function platformOwned(name) {
  return PLATFORM_OWNED_EXACT.has(name) || PLATFORM_OWNED_PREFIXES.some((re) => re.test(name));
}
function safeDir(dir, where) {
  if (dir === void 0 || dir === null || dir === "") return ".";
  if (typeof dir !== "string") throw new ConfigError(`${where}: "dir" must be a string`);
  const d = dir.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!d || d === ".") return ".";
  if (d.startsWith("/") || d.split("/").includes("..")) {
    throw new ConfigError(`${where}: "dir" must be inside the repository (got ${JSON.stringify(dir)})`);
  }
  return d;
}
function str(v, where) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "string") throw new ConfigError(`${where} must be a string`);
  return v;
}
function num(v, where) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`${where} must be a number`);
  return v;
}
function literals(v, where) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError(`${where} must be an object of NAME: value, or an array of variable NAMES`);
  }
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (platformOwned(k)) {
      throw new ConfigError(
        `${where}: "${k}" is set by the platform and cannot be declared here. Remove it \u2014 the value the app receives is the one the platform provisions.`
      );
    }
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new ConfigError(`${where}.${k} must be a string, number or boolean`);
    }
    out[k] = String(raw);
  }
  return out;
}
function names(v, where) {
  if (v === void 0 || v === null) return void 0;
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new ConfigError(`${where} must be an array of variable NAMES`);
  }
  for (const n of v) {
    if (platformOwned(n)) {
      throw new ConfigError(`${where}: "${n}" is set by the platform and cannot be declared here.`);
    }
  }
  return v;
}
function health(v, where) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  const o = v;
  const path = str(o.path, `${where}.path`) ?? "/";
  if (!path.startsWith("/")) throw new ConfigError(`${where}.path must start with /`);
  const expect = num(o.expect, `${where}.expect`) ?? 200;
  if (expect < 100 || expect > 599) throw new ConfigError(`${where}.expect must be an HTTP status code`);
  return { path, expect };
}
function scale(v, where) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  const o = v;
  const memory = str(o.memory, `${where}.memory`);
  if (memory !== void 0 && !/^\d+(Mi|Gi)$/.test(memory)) {
    throw new ConfigError(`${where}.memory must look like "512Mi" or "2Gi" (got ${JSON.stringify(memory)})`);
  }
  return {
    memory,
    cpu: num(o.cpu, `${where}.cpu`),
    maxInstances: num(o.maxInstances, `${where}.maxInstances`),
    timeout: num(o.timeout, `${where}.timeout`),
    concurrency: num(o.concurrency, `${where}.concurrency`),
    cpuBoost: o.cpuBoost === void 0 ? void 0 : Boolean(o.cpuBoost)
  };
}
function resources(v) {
  if (v === void 0 || v === null) return void 0;
  const where = `${CONFIG_FILENAME} resources`;
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  const o = v;
  let database;
  if (o.database !== void 0 && o.database !== null && o.database !== false) {
    if (typeof o.database !== "object" || Array.isArray(o.database)) {
      throw new ConfigError(`${where}.database must be an object`);
    }
    const d = o.database;
    const engine = str(d.engine, `${where}.database.engine`) ?? "postgres";
    if (engine !== "postgres") throw new ConfigError(`${where}.database.engine: only "postgres" is provisioned today (got ${JSON.stringify(engine)})`);
    database = { engine: "postgres", version: str(d.version, `${where}.database.version`) };
  }
  return { database, bucket: o.bucket === void 0 ? void 0 : Boolean(o.bucket) };
}
function parseAppConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILENAME} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${CONFIG_FILENAME} must be a JSON object`);
  const o = raw;
  if (!Array.isArray(o.services) || o.services.length === 0) {
    throw new ConfigError(`${CONFIG_FILENAME} needs a non-empty "services" array`);
  }
  const services = o.services.map((s, i) => {
    const where = `${CONFIG_FILENAME} services[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new ConfigError(`${where} must be an object`);
    const svc = s;
    const language = str(svc.language, `${where}.language`);
    if (language !== void 0 && !LANGUAGES.has(language)) {
      throw new ConfigError(`${where}.language must be one of ${[...LANGUAGES].join(", ")}`);
    }
    const envIsNameList = Array.isArray(svc.env);
    const uses = svc.uses === void 0 ? void 0 : names(svc.uses, `${where}.uses`);
    for (const u of uses ?? []) {
      if (u !== "database" && u !== "bucket") {
        throw new ConfigError(`${where}.uses: "${u}" is not a resource \u2014 expected "database" or "bucket"`);
      }
    }
    return {
      name: str(svc.name, `${where}.name`),
      dir: safeDir(svc.dir, where),
      language,
      runtime: str(svc.runtime, `${where}.runtime`),
      framework: str(svc.framework, `${where}.framework`),
      install: str(svc.install, `${where}.install`),
      build: str(svc.build, `${where}.build`),
      preDeploy: str(svc.preDeploy, `${where}.preDeploy`),
      release: str(svc.release, `${where}.release`),
      start: str(svc.start, `${where}.start`),
      outputDir: str(svc.outputDir, `${where}.outputDir`),
      spaFallback: svc.spaFallback === void 0 ? void 0 : Boolean(svc.spaFallback),
      dockerfile: str(svc.dockerfile, `${where}.dockerfile`),
      context: svc.context === void 0 ? void 0 : safeDir(svc.context, `${where}.context`),
      needsDB: svc.needsDB === void 0 ? void 0 : Boolean(svc.needsDB),
      uses,
      env: envIsNameList ? void 0 : literals(svc.env, `${where}.env`),
      envNeeded: envIsNameList ? names(svc.env, `${where}.env`) : void 0,
      buildEnv: literals(svc.buildEnv, `${where}.buildEnv`),
      secrets: names(svc.secrets, `${where}.secrets`),
      health: health(svc.health, `${where}.health`),
      scale: scale(svc.scale, `${where}.scale`),
      path: str(svc.path, `${where}.path`)
    };
  });
  for (const [i, s] of services.entries()) {
    if (s.preDeploy !== void 0 && s.release !== void 0 && s.preDeploy !== s.release) {
      throw new ConfigError(
        `${CONFIG_FILENAME} services[${i}]: "preDeploy" and "release" are the same field \u2014 keep "release".`
      );
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const s of services) {
    const p = servicePath(s);
    if (seen.has(p)) throw new ConfigError(`${CONFIG_FILENAME}: two services both serve ${p}`);
    seen.add(p);
  }
  return {
    version: typeof o.version === "number" ? o.version : 1,
    resources: appResources(resources(o.resources), services),
    services
  };
}
function appResources(declared, services) {
  const wantsDb = services.some(usesDatabase);
  const wantsBucket = services.some((s) => (s.uses ?? []).includes("bucket"));
  const database = declared?.database ?? (wantsDb ? { engine: "postgres" } : void 0);
  const bucket = declared?.bucket ?? (wantsBucket ? true : void 0);
  if (!database && bucket === void 0) return declared;
  return { database, bucket };
}
function primaryService(config) {
  return config.services.find((s) => (s.path ?? "/") === "/") ?? config.services[0];
}
function servicePath(s) {
  const p = (s.path ?? "/").trim();
  if (!p.startsWith("/")) throw new ConfigError(`${CONFIG_FILENAME}: "path" must start with / (got ${JSON.stringify(s.path)})`);
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
function inDir(cmd, dir) {
  if (cmd === void 0) return void 0;
  if (!cmd.trim()) return "";
  return dir === "." ? cmd : `(cd ${dir} && ${cmd})`;
}
function usesDatabase(s) {
  return Boolean(s.needsDB) || (s.uses ?? []).includes("database");
}
function releaseCommand(s) {
  return s.release ?? s.preDeploy;
}
function readAppConfig(dir) {
  const path = (0, import_node_path.join)(dir, CONFIG_FILENAME);
  if (!(0, import_node_fs.existsSync)(path)) return null;
  return parseAppConfig((0, import_node_fs.readFileSync)(path, "utf8"));
}

// lib/infer-services.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");

// lib/repo-facts.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
var MANIFESTS = {
  "package.json": "node",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "Pipfile": "python",
  "setup.py": "python",
  "uv.lock": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "Gemfile": "ruby",
  "composer.json": "php",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "java"
};
var SKIP = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".terraform",
  "site-packages"
]);
var MAX_DEPTH = 3;
function readRepoFacts(dir) {
  const declarations = [];
  const dockerfiles = [];
  let frontier = [{ abs: dir, rel: "", depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const cur of frontier) {
      let entries;
      try {
        entries = (0, import_node_fs2.readdirSync)(cur.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
          if (cur.depth + 1 <= MAX_DEPTH) next.push({ abs: (0, import_node_path2.join)(cur.abs, e.name), rel, depth: cur.depth + 1 });
          continue;
        }
        if (!e.isFile()) continue;
        if (e.name === "Dockerfile") dockerfiles.push(rel);
        const language = MANIFESTS[e.name];
        if (language) declarations.push({ language, from: rel, root: cur.depth === 0 });
      }
    }
    frontier = next;
  }
  return { declarations, dockerfiles };
}
function declaredLanguages(facts) {
  const seen = /* @__PURE__ */ new Set();
  for (const d of facts.declarations) seen.add(d.language);
  return [...seen];
}
function normalizeLanguage(runtime) {
  const r = String(runtime || "").toLowerCase();
  if (!r) return null;
  if (r.startsWith("node")) return "node";
  if (r.startsWith("python")) return "python";
  if (r.startsWith("go")) return "go";
  if (r.startsWith("rust")) return "rust";
  if (r.startsWith("ruby")) return "ruby";
  if (r.startsWith("php")) return "php";
  if (r.startsWith("java")) return "java";
  return null;
}

// lib/infer-services.ts
var BROWSER_FACING = /next\.?js|nuxt|remix|sveltekit|astro|vite|create react app|static/i;
var PYTHON_ENTRIES = ["main.py", "app/main.py", "src/main.py", "app.py", "api/main.py", "src/app.py"];
var NOT_AN_APP = /* @__PURE__ */ new Set([
  "e2e",
  "test",
  "tests",
  "spec",
  "specs",
  "docs",
  "doc",
  "examples",
  "example",
  "fixtures",
  "scripts",
  "tools",
  "infra",
  "terraform",
  "deploy",
  "deployment",
  "ci",
  "benchmark",
  "benchmarks",
  "bench",
  "migrations",
  "seeds"
]);
var NODE_FRAMEWORK = /^(next|nuxt|astro|vite|@remix-run\/|@sveltejs\/kit|@nestjs\/core|express|fastify|koa|hono)/;
var PYTHON_RUNNABLE = [...PYTHON_ENTRIES, "manage.py", "wsgi.py", "asgi.py"];
function dirOf(manifestPath) {
  const i = manifestPath.lastIndexOf("/");
  return i === -1 ? "." : manifestPath.slice(0, i);
}
function isWorkspaceRoot(repoDir) {
  const p = (0, import_node_path3.join)(repoDir, "package.json");
  if (!(0, import_node_fs3.existsSync)(p)) return false;
  try {
    return Boolean(JSON.parse((0, import_node_fs3.readFileSync)(p, "utf8")).workspaces);
  } catch {
    return false;
  }
}
function isDeployablePart(absoluteDir, relDir) {
  if (relDir.split("/").some((seg) => NOT_AN_APP.has(seg.toLowerCase()))) return false;
  const pkgPath = (0, import_node_path3.join)(absoluteDir, "package.json");
  if ((0, import_node_fs3.existsSync)(pkgPath)) {
    try {
      const pkg = JSON.parse((0, import_node_fs3.readFileSync)(pkgPath, "utf8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.build || scripts.start) return true;
      const deps = Object.keys({ ...pkg.dependencies ?? {}, ...pkg.devDependencies ?? {} });
      return deps.some((d) => NODE_FRAMEWORK.test(d));
    } catch {
      return false;
    }
  }
  return PYTHON_RUNNABLE.some((entry) => (0, import_node_fs3.existsSync)((0, import_node_path3.join)(absoluteDir, entry)));
}
function bindToPort(cmd) {
  return cmd.replace(/(--port[= ])\d+/g, "$1$PORT").replace(/(--bind[= ]\S*?:)\d+/g, "$1$PORT").replace(/(-b\s+\S*?:)\d+/g, "$1$PORT").replace(/(-p\s+)\d+/g, "$1$PORT");
}
function pythonModule(serviceDir) {
  for (const entry of PYTHON_ENTRIES) {
    if ((0, import_node_fs3.existsSync)((0, import_node_path3.join)(serviceDir, entry))) return entry.replace(/\.py$/, "").split("/").join(".");
  }
  return null;
}
function startFor(stack, absoluteDir) {
  const bound = bindToPort(stack.startCommand);
  if (!/^python/i.test(stack.language)) return bound;
  const mod = pythonModule(absoluteDir);
  if (!mod) return bound;
  return bound.replace(/\b(?:main|app)(?=:app\b)/, mod);
}
function pythonInstall(serviceDir, detected) {
  if ((0, import_node_fs3.existsSync)((0, import_node_path3.join)(serviceDir, "requirements.txt"))) return detected ?? "pip install --no-cache-dir -r requirements.txt";
  if ((0, import_node_fs3.existsSync)((0, import_node_path3.join)(serviceDir, "pyproject.toml"))) return "pip install --no-cache-dir .";
  return void 0;
}
function languageOf(stack) {
  if (stack.serve.mode === "static") return "static";
  if (/^python/i.test(stack.language)) return "python";
  if (/^(java)?script|^typescript/i.test(stack.language)) return "node";
  return "other";
}
function serviceFor(relDir, stack, absoluteDir) {
  const language = languageOf(stack);
  const name = relDir === "." ? "app" : import_node_path3.posix.basename(relDir);
  const base = {
    name,
    dir: relDir,
    language,
    install: language === "python" ? pythonInstall(absoluteDir, stack.installCommand) : stack.installCommand ?? void 0,
    build: stack.buildCommand ?? void 0,
    needsDB: stack.database?.engine ? true : void 0
  };
  if (language === "static") {
    return { ...base, outputDir: stack.serve.mode === "static" ? stack.serve.outputDir : "dist" };
  }
  return { ...base, start: startFor(stack, absoluteDir) };
}
function deployableParts(repoDir, facts) {
  const dirs = [];
  for (const d of facts.declarations) {
    const dir = dirOf(d.from);
    if (dirs.includes(dir)) continue;
    if (!isDeployablePart(dir === "." ? repoDir : (0, import_node_path3.join)(repoDir, dir), dir)) continue;
    dirs.push(dir);
  }
  const nested = dirs.filter((d) => d !== ".");
  return nested.length >= 2 || dirs.includes(".") && isWorkspaceRoot(repoDir) ? nested : dirs;
}
async function inferAppConfig(repoDir, detect) {
  const facts = readRepoFacts(repoDir);
  if (!facts.declarations.length) return null;
  if (facts.dockerfiles.includes("Dockerfile")) return null;
  const parts = deployableParts(repoDir, facts);
  if (parts.length < 2) return null;
  let detected;
  try {
    detected = await Promise.all(parts.map(async (rel) => {
      const abs = rel === "." ? repoDir : (0, import_node_path3.join)(repoDir, rel);
      return { rel, abs, stack: await detect(abs) };
    }));
  } catch {
    return null;
  }
  const primaryIdx = Math.max(0, detected.findIndex((p) => BROWSER_FACING.test(p.stack.framework)));
  const ordered = [detected[primaryIdx], ...detected.filter((_, i) => i !== primaryIdx)];
  const services = ordered.map((p, i) => {
    const svc = serviceFor(p.rel, p.stack, p.abs);
    if (i === 0) return { ...svc, path: "/" };
    return { ...svc, path: ordered.length === 2 ? "/api" : `/${svc.name}` };
  });
  return { version: 1, services };
}

// lib/resolve.ts
var ResolveError = class extends Error {
};
var RUNNER_RUNTIMES = [/^node/, /^python/];
function deriveLane(s) {
  if (s.language === "static") return "static";
  if (s.dockerfile) return "container";
  const runtime = s.runtime ?? "";
  if (RUNNER_RUNTIMES.some((re) => re.test(runtime))) return "runner";
  if (runtime) return "buildpack";
  if (s.language === "node" || s.language === "python") return "runner";
  return "buildpack";
}
var LANE_CONSUMES = {
  static: ["install", "build", "outputDir", "spaFallback", "buildEnv", "env"],
  runner: ["install", "build", "release", "start", "env", "buildEnv", "secrets", "uses", "health", "scale", "runtime", "framework"],
  // No `start`: the Dockerfile's own CMD is the start command, and a second one
  // in the config would be read by nobody.
  container: ["dockerfile", "context", "release", "env", "buildEnv", "secrets", "uses", "health", "scale", "framework"],
  buildpack: ["install", "build", "release", "start", "env", "buildEnv", "secrets", "uses", "health", "scale", "runtime", "framework"]
};
var UNIVERSAL = ["name", "dir", "path", "lane", "envNeeded", "declared"];
function assertConsumed(s) {
  const allowed = /* @__PURE__ */ new Set([...LANE_CONSUMES[s.lane], ...UNIVERSAL]);
  const ignored = s.declared.filter((f) => !allowed.has(f));
  if (!ignored.length) return;
  throw new ResolveError(
    `the ${s.lane} lane does not implement: ${ignored.join(", ")}
  Service "${s.name}" declares ${ignored.length === 1 ? "it" : "them"} and the deploy would ignore ${ignored.length === 1 ? "it" : "them"} silently.
` + (s.lane === "static" ? `  Move ${ignored.length === 1 ? "it" : "them"} to a service with a \`start\` command, or remove ${ignored.length === 1 ? "it" : "them"}.` : `  Remove ${ignored.length === 1 ? "it" : "them"}, or change the service so this lane applies.`)
  );
}
function healthOf(s) {
  return s.health ?? { path: "/", expect: 200 };
}
function declaredFields(s) {
  const out = [];
  const set = (v) => v !== void 0 && v !== null && !(typeof v === "string" && !v.trim());
  if (set(s.install)) out.push("install");
  if (set(s.build)) out.push("build");
  if (set(s.release) || set(s.preDeploy)) out.push("release");
  if (set(s.start)) out.push("start");
  if (set(s.outputDir)) out.push("outputDir");
  if (s.spaFallback) out.push("spaFallback");
  if (set(s.dockerfile)) out.push("dockerfile");
  if (set(s.context)) out.push("context");
  if (s.needsDB || (s.uses ?? []).length) out.push("uses");
  if (s.env && Object.keys(s.env).length) out.push("env");
  if (s.buildEnv && Object.keys(s.buildEnv).length) out.push("buildEnv");
  if ((s.secrets ?? []).length) out.push("secrets");
  if (set(s.health)) out.push("health");
  if (set(s.scale)) out.push("scale");
  if (set(s.runtime)) out.push("runtime");
  if (set(s.framework)) out.push("framework");
  return out;
}
function resolveService(s, index) {
  const dir = s.dir ?? ".";
  const lane = deriveLane(s);
  const name = s.name ?? (index === 0 ? "app" : `svc${index}`);
  return {
    name,
    dir,
    path: servicePath(s),
    lane,
    runtime: s.runtime,
    framework: s.framework,
    // Wrapped in a subshell here, once, rather than by each lane — see inDir for
    // why the parentheses are load-bearing.
    install: inDir(s.install, dir),
    build: inDir(s.build, dir),
    release: inDir(releaseCommand(s), dir),
    start: inDir(s.start, dir),
    // Relative to the repo root, because that is what the uploader and the
    // static lane both address.
    outputDir: s.language === "static" ? dir === "." ? s.outputDir ?? "." : `${dir}/${s.outputDir ?? "."}`.replace(/\/\.$/, "") : void 0,
    spaFallback: Boolean(s.spaFallback),
    dockerfile: s.dockerfile,
    context: s.dockerfile ? s.context ?? dir : void 0,
    uses: s.uses ?? (s.needsDB ? ["database"] : []),
    env: s.env ?? {},
    buildEnv: s.buildEnv ?? {},
    secrets: s.secrets ?? [],
    envNeeded: s.envNeeded ?? [],
    health: healthOf(s),
    scale: withScale(s.scale),
    declared: declaredFields(s)
  };
}
async function resolve(dir, detect) {
  let config = null;
  let source = "config";
  config = readAppConfig(dir);
  if (!config) {
    if (!detect) throw new ResolveError(`${dir} has no ${CONFIG_FILENAME} and no detector was supplied \u2014 run \`supersonic init\``);
    config = await inferAppConfig(dir, detect);
    source = "inferred";
  }
  if (!config) {
    throw new ResolveError(
      `could not work out how to deploy ${dir}.
  Run \`supersonic init\` to write a ${CONFIG_FILENAME} draft, then check it.`
    );
  }
  const primary = primaryService(config);
  const ordered = [primary, ...config.services.filter((s) => s !== primary)];
  return {
    source,
    // Normalised here rather than only in the parser, so `uses` and `needsDB`
    // mean the same thing for an INFERRED app as for a written one. Inference
    // builds an AppConfig directly and never passes through parseAppConfig, and
    // a rule that holds on one of two paths is the shape of bug this whole
    // module exists to end.
    resources: appResources(config.resources, config.services) ?? {},
    services: ordered.map(resolveService)
  };
}
function validate(app, dir) {
  const problems = [];
  if (!app.services.length) problems.push(`${CONFIG_FILENAME}: no services to deploy`);
  const paths = /* @__PURE__ */ new Set();
  for (const s of app.services) {
    const where = `service "${s.name}"`;
    if (paths.has(s.path)) problems.push(`${where}: two services both serve ${s.path}`);
    paths.add(s.path);
    const abs = (0, import_node_path4.join)(dir, s.dir);
    if (!(0, import_node_fs4.existsSync)(abs)) {
      problems.push(`${where}: directory "${s.dir}" does not exist`);
      continue;
    }
    if (s.lane === "static") {
      if (s.build && !s.declared.includes("outputDir")) {
        problems.push(`${where}: has a build command but no outputDir \u2014 what should be published?`);
      }
      if (!s.build && s.outputDir && !(0, import_node_fs4.existsSync)((0, import_node_path4.join)(dir, s.outputDir))) {
        problems.push(`${where}: outputDir "${s.outputDir}" does not exist and no build command would create it`);
      }
    } else if (s.lane !== "container" && !s.start) {
      problems.push(`${where}: the ${s.lane} lane runs a server and this service has no \`start\` command`);
    }
    if (s.dockerfile) {
      if (!(0, import_node_fs4.existsSync)((0, import_node_path4.join)(dir, s.dockerfile))) {
        problems.push(`${where}: dockerfile "${s.dockerfile}" does not exist`);
      }
      if (s.context && !(0, import_node_fs4.existsSync)((0, import_node_path4.join)(dir, s.context))) {
        problems.push(`${where}: build context "${s.context}" does not exist`);
      }
    }
    try {
      assertConsumed(s);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (problems.length) {
    throw new ResolveError(problems.map((p) => `\u2715 ${p}`).join("\n"));
  }
}
function missingSecrets(app, available) {
  const have = new Set(available);
  const want = new Set(app.services.flatMap((s) => s.secrets));
  return [...want].filter((n) => !have.has(n)).sort();
}

// lib/plan-deps.ts
var RUNTIME_VERSIONS = { python: "3.14", node: "24" };
var RUNTIME_UNSUPPORTED = "Runtime not available";
function lowestAccepted(spec) {
  const m = spec.match(/>=\s*(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}
function below(have, need) {
  const [hMaj, hMin] = have.split(".").map(Number);
  return hMaj < need[0] || hMaj === need[0] && (hMin ?? 0) < need[1];
}
function runtimeMismatch(manifests) {
  const py = manifests.pyproject?.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (py) {
    const need = lowestAccepted(py);
    if (need && below(RUNTIME_VERSIONS.python, need)) {
      return `this app needs Python ${py} and the runner has ${RUNTIME_VERSIONS.python} \u2014 widen requires-python in pyproject.toml to accept ${RUNTIME_VERSIONS.python}, or wait for the runner to move. Nothing in the code can fix this one.`;
    }
  }
  const engines = manifests.packageJson?.engines?.node;
  if (engines) {
    const need = lowestAccepted(engines);
    if (need && below(RUNTIME_VERSIONS.node, need)) {
      return `this app needs Node ${engines} and the runner has ${RUNTIME_VERSIONS.node} \u2014 widen engines.node in package.json to accept ${RUNTIME_VERSIONS.node}, or wait for the runner to move. Nothing in the code can fix this one.`;
    }
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CONFIG_FILENAME,
  ConfigError,
  DEFAULT_SCALE,
  RUNTIME_UNSUPPORTED,
  RUNTIME_VERSIONS,
  ResolveError,
  appResources,
  assertConsumed,
  bindToPort,
  declaredLanguages,
  deployableParts,
  deriveLane,
  inferAppConfig,
  isDeployablePart,
  missingSecrets,
  normalizeLanguage,
  parseAppConfig,
  platformOwned,
  primaryService,
  pythonInstall,
  pythonModule,
  readAppConfig,
  readRepoFacts,
  resolve,
  runtimeMismatch,
  serviceFor,
  servicePath,
  validate
});
