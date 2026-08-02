// supersonic-vendor-stamp 93ec6d478cb7b4c9
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
  PRIMITIVE: () => PRIMITIVE,
  ProcessError: () => ProcessError,
  ProcfileError: () => ProcfileError,
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
  isServiceless: () => isServiceless,
  mergeProcfile: () => mergeProcfile,
  missingSecrets: () => missingSecrets,
  normalizeLanguage: () => normalizeLanguage,
  parseAppConfig: () => parseAppConfig,
  parseProcfile: () => parseProcfile,
  platformOwned: () => platformOwned,
  primaryService: () => primaryService,
  pythonInstall: () => pythonInstall,
  pythonModule: () => pythonModule,
  readAppConfig: () => readAppConfig,
  readProcfile: () => readProcfile,
  readRepoFacts: () => readRepoFacts,
  resolve: () => resolve,
  resolveProcesses: () => resolveProcesses,
  runtimeMismatch: () => runtimeMismatch,
  serviceFor: () => serviceFor,
  servicePath: () => servicePath,
  unemittable: () => unemittable,
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
var SERVICE_LANES = ["runner", "container", "buildpack"];
var ALL_LANES = ["static", ...SERVICE_LANES];
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
  const declared = Object.fromEntries(
    Object.entries(over ?? {}).filter(([, v]) => v !== void 0)
  );
  return { ...DEFAULT_SCALE, ...declared };
}

// lib/app-config.ts
var CONFIG_FILENAME = "supersonic.json";
var ConfigError = class extends Error {
};
var LANGUAGES = /* @__PURE__ */ new Set(["node", "python", "static", "other"]);
var ALWAYS_OWNED_PREFIXES = [/^SUPERSONIC_/];
var ALWAYS_OWNED_EXACT = /* @__PURE__ */ new Set(["PORT"]);
var DATABASE_OWNED_PREFIXES = [/^POSTGRES_/, /^PG/, /^DB_/];
var DATABASE_OWNED_EXACT = new Set(databaseEnvNames());
function platformOwned(name, database) {
  if (ALWAYS_OWNED_EXACT.has(name) || ALWAYS_OWNED_PREFIXES.some((re) => re.test(name))) return true;
  if (database?.provider !== "managed") return false;
  return DATABASE_OWNED_EXACT.has(name) || DATABASE_OWNED_PREFIXES.some((re) => re.test(name));
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
function literals(v, where, database) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError(`${where} must be an object of NAME: value, or an array of variable NAMES`);
  }
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (platformOwned(k, database)) {
      throw new ConfigError(
        `${where}: "${k}" is set by the platform and cannot be declared here. ` + ownedBecause(k, database)
      );
    }
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new ConfigError(`${where}.${k} must be a string, number or boolean`);
    }
    out[k] = String(raw);
  }
  return out;
}
function ownedBecause(name, database) {
  if (ALWAYS_OWNED_EXACT.has(name) || ALWAYS_OWNED_PREFIXES.some((re) => re.test(name))) {
    return name === "PORT" ? `Cloud Run assigns the port and injects it \u2014 read it from the environment instead.` : `SUPERSONIC_* is the platform's own namespace.`;
  }
  return `The platform provisions this app's database, so it writes this value itself. If the app already HAS a database, declare it instead: "resources": { "database": { "provider": "external", "urlFrom": "${name}" } }`;
}
function names(v, where, database) {
  if (v === void 0 || v === null) return void 0;
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new ConfigError(`${where} must be an array of variable NAMES`);
  }
  for (const n of v) {
    if (platformOwned(n, database)) {
      throw new ConfigError(`${where}: "${n}" is set by the platform and cannot be declared here. ` + ownedBecause(n, database));
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
function processConfigs(v, where) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError(`${where} must be an object of NAME: { command, \u2026 } \u2014 for example { "web": { "command": "\u2026" } }`);
  }
  const out = {};
  for (const [name, raw] of Object.entries(v)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new ConfigError(`${where}: "${name}" is not a valid process name \u2014 letters, digits, "-" and "_" only`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`${where}.${name} must be an object`);
    }
    const p = raw;
    out[name] = {
      command: str(p.command, `${where}.${name}.command`),
      kind: str(p.kind, `${where}.${name}.kind`),
      memory: str(p.memory, `${where}.${name}.memory`),
      cpu: num(p.cpu, `${where}.${name}.cpu`),
      visibility: str(p.visibility, `${where}.${name}.visibility`),
      health: health(p.health, `${where}.${name}.health`),
      maxInstances: num(p.maxInstances, `${where}.${name}.maxInstances`),
      concurrency: num(p.concurrency, `${where}.${name}.concurrency`),
      cpuBoost: p.cpuBoost === void 0 ? void 0 : Boolean(p.cpuBoost),
      timeout: num(p.timeout, `${where}.${name}.timeout`),
      instances: num(p.instances, `${where}.${name}.instances`),
      schedule: str(p.schedule, `${where}.${name}.schedule`),
      timezone: str(p.timezone, `${where}.${name}.timezone`),
      taskTimeout: num(p.taskTimeout, `${where}.${name}.taskTimeout`),
      retries: num(p.retries, `${where}.${name}.retries`),
      shutdownGrace: num(p.shutdownGrace, `${where}.${name}.shutdownGrace`)
    };
    for (const k of Object.keys(out[name])) {
      if (out[name][k] === void 0) delete out[name][k];
    }
    if (out[name].visibility !== void 0 && out[name].visibility !== "public" && out[name].visibility !== "internal") {
      throw new ConfigError(`${where}.${name}.visibility must be "public" or "internal"`);
    }
    if (out[name].kind !== void 0 && !PROCESS_KINDS.has(out[name].kind)) {
      throw new ConfigError(`${where}.${name}.kind must be one of ${[...PROCESS_KINDS].join(", ")}`);
    }
  }
  return out;
}
var PROCESS_KINDS = /* @__PURE__ */ new Set(["web", "worker", "cron", "release"]);
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
    const provider = str(d.provider, `${where}.database.provider`) ?? "managed";
    if (provider !== "managed" && provider !== "external") {
      throw new ConfigError(
        `${where}.database.provider must be "managed" (the platform creates it) or "external" (it already exists and the platform only injects it) \u2014 got ${JSON.stringify(provider)}`
      );
    }
    if (provider === "external") {
      const urlFrom = str(d.urlFrom, `${where}.database.urlFrom`)?.trim();
      if (!urlFrom) {
        throw new ConfigError(
          `${where}.database: an external database needs "urlFrom" \u2014 the NAME of the secret holding its connection URL, for example "DATABASE_URL". The value itself belongs in your .env or in \`supersonic env set\`, never in this file.`
        );
      }
      if (platformOwned(urlFrom)) {
        throw new ConfigError(`${where}.database.urlFrom: "${urlFrom}" is set by the platform and cannot hold your connection URL.`);
      }
      database = { provider: "external", engine: str(d.engine, `${where}.database.engine`), urlFrom };
    } else {
      const engine = str(d.engine, `${where}.database.engine`) ?? "postgres";
      if (engine !== "postgres") {
        throw new ConfigError(
          `${where}.database.engine: only "postgres" is provisioned today (got ${JSON.stringify(engine)}). An ${engine} the app already has can be declared with "provider": "external".`
        );
      }
      database = { provider: "managed", engine: "postgres", version: str(d.version, `${where}.database.version`) };
    }
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
  const declaredResources = resources(o.resources);
  const database = declaredDatabase(declaredResources, o.services);
  const services = o.services.map((s, i) => {
    const where = `${CONFIG_FILENAME} services[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new ConfigError(`${where} must be an object`);
    const svc = s;
    const language = str(svc.language, `${where}.language`);
    if (language !== void 0 && !LANGUAGES.has(language)) {
      throw new ConfigError(`${where}.language must be one of ${[...LANGUAGES].join(", ")}`);
    }
    const envIsNameList = Array.isArray(svc.env);
    const uses = svc.uses === void 0 ? void 0 : names(svc.uses, `${where}.uses`, database);
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
      processes: processConfigs(svc.processes, `${where}.processes`),
      outputDir: str(svc.outputDir, `${where}.outputDir`),
      spaFallback: svc.spaFallback === void 0 ? void 0 : Boolean(svc.spaFallback),
      dockerfile: str(svc.dockerfile, `${where}.dockerfile`),
      context: svc.context === void 0 ? void 0 : safeDir(svc.context, `${where}.context`),
      needsDB: svc.needsDB === void 0 ? void 0 : Boolean(svc.needsDB),
      uses,
      env: envIsNameList ? void 0 : literals(svc.env, `${where}.env`, database),
      envNeeded: envIsNameList ? names(svc.env, `${where}.env`, database) : void 0,
      buildEnv: literals(svc.buildEnv, `${where}.buildEnv`, database),
      secrets: names(svc.secrets, `${where}.secrets`, database),
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
  for (const [i, s] of services.entries()) {
    if (!s.processes || s === primaryService({ services })) continue;
    throw new ConfigError(
      `${CONFIG_FILENAME} services[${i}]: "processes" on a sibling service is not deployed yet.
  Only the service on "/" runs workers and crons today. Move them there, or give this service its own app.`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  for (const s of services) {
    const p = servicePath(s);
    if (seen.has(p)) throw new ConfigError(`${CONFIG_FILENAME}: two services both serve ${p}`);
    seen.add(p);
  }
  return {
    version: typeof o.version === "number" ? o.version : 1,
    resources: appResources(declaredResources, services),
    services
  };
}
function declaredDatabase(declared, rawServices) {
  if (declared?.database) return declared.database;
  const wants = rawServices.some((s) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) return false;
    const svc = s;
    return Boolean(svc.needsDB) || Array.isArray(svc.uses) && svc.uses.includes("database");
  });
  return wants ? { provider: "managed", engine: "postgres" } : void 0;
}
function appResources(declared, services) {
  const wantsDb = services.some(usesDatabase);
  const wantsBucket = services.some((s) => (s.uses ?? []).includes("bucket"));
  const database = declared?.database ?? (wantsDb ? { provider: "managed", engine: "postgres" } : void 0);
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
  return s.release ?? s.preDeploy ?? s.processes?.release?.command;
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
function laneFor(i) {
  if (i.language === "static") return "static";
  const runnerAllowed = i.runnerEnabled ?? true;
  if (i.dockerfile && !i.runCommandSupplied) return "container";
  const runtime = i.runtime ?? "";
  const wantsRunner = RUNNER_RUNTIMES.some((re) => re.test(runtime)) || !runtime && (i.language === "node" || i.language === "python");
  if (wantsRunner) return runnerAllowed ? "runner" : i.dockerfile ? "container" : "buildpack";
  if (i.dockerfile) return "container";
  return "buildpack";
}
function deriveLane(s) {
  return laneFor({ language: s.language, runtime: s.runtime, dockerfile: s.dockerfile });
}
var LANE_CONSUMES = {
  static: ["install", "build", "outputDir", "spaFallback", "buildEnv", "env"],
  runner: ["install", "build", "release", "start", "processes", "env", "buildEnv", "secrets", "uses", "health", "scale", "runtime", "framework"],
  // No `start`: the Dockerfile's own CMD is the start command, and a second one
  // in the config would be read by nobody.
  container: ["dockerfile", "context", "release", "processes", "env", "buildEnv", "secrets", "uses", "health", "scale", "framework"],
  buildpack: ["install", "build", "release", "start", "processes", "env", "buildEnv", "secrets", "uses", "health", "scale", "runtime", "framework"]
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
  if (Object.keys(s.processes ?? {}).length) out.push("processes");
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
    processes: Object.keys(s.processes ?? {}),
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
  return resolveFrom(config, source);
}
function resolveFrom(config, source) {
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
    } else if (s.lane !== "container" && !s.start && !s.processes.length) {
      problems.push(
        `${where}: the ${s.lane} lane runs a server and this service has no \`start\` command
  If this app is a worker, a bot or a scheduled job, declare "processes" instead.`
      );
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
  const db = app.resources.database;
  if (db?.provider === "external") want.add(db.urlFrom);
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

// lib/procfile.ts
var import_node_fs5 = require("node:fs");
var import_node_path5 = require("node:path");
var PROCFILE = "Procfile";
var ENTRY = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
var ProcfileError = class extends Error {
};
function parseProcfile(text) {
  const out = [];
  const seen = /* @__PURE__ */ new Map();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const m = ENTRY.exec(trimmed);
    if (!m) {
      throw new ProcfileError(
        `${PROCFILE} line ${line}: expected "name: command", got ${JSON.stringify(trimmed)}`
      );
    }
    const name = m[1].toLowerCase();
    const command = m[2].trim();
    if (!command) throw new ProcfileError(`${PROCFILE} line ${line}: "${name}" has no command`);
    const first = seen.get(name);
    if (first !== void 0) {
      throw new ProcfileError(`${PROCFILE}: "${name}" is declared twice, on lines ${first} and ${line}`);
    }
    seen.set(name, line);
    out.push({ name, command, line });
  });
  return out;
}
function readProcfile(dir) {
  const path = (0, import_node_path5.join)(dir, PROCFILE);
  if (!(0, import_node_fs5.existsSync)(path)) return null;
  return parseProcfile((0, import_node_fs5.readFileSync)(path, "utf8"));
}

// lib/release-job.ts
var RELEASE_TIMEOUT = 1800;

// lib/processes.ts
var PRIMITIVE = {
  web: "service",
  worker: "worker-pool",
  cron: "job",
  release: "job"
};
var WEB = "web";
var RELEASE = "release";
var ProcessError = class extends Error {
};
var ALLOWED = {
  web: ["command", "kind", "memory", "cpu", "visibility", "health", "maxInstances", "concurrency", "cpuBoost", "timeout", "shutdownGrace"],
  worker: ["command", "kind", "memory", "cpu", "instances", "shutdownGrace"],
  cron: ["command", "kind", "memory", "cpu", "schedule", "timezone", "taskTimeout", "retries"],
  release: ["command", "kind", "memory", "cpu", "taskTimeout", "retries"]
};
function unemittable(p) {
  const out = [];
  if ((p.kind === "web" || p.kind === "worker") && p.shutdownGrace !== void 0) {
    out.push(
      `${p.name}.shutdownGrace is not emitted yet \u2014 terminationGracePeriodSeconds has no gcloud flag and needs the spec-replace path (DEPLOY-PLAN-V2 step 4)`
    );
  }
  return out;
}
var DEFAULT_TASK_TIMEOUT = RELEASE_TIMEOUT;
var DEFAULT_RETRIES = 0;
var DEFAULT_INSTANCES = 1;
function deriveKind(name, c) {
  if (c.kind) return c.kind;
  if (c.schedule) return "cron";
  if (name === WEB) return "web";
  if (name === RELEASE) return "release";
  return "worker";
}
function declaredFields2(c) {
  const set = (v) => v !== void 0 && v !== null && !(typeof v === "string" && !v.trim());
  return Object.keys(c).filter((k) => set(c[k]));
}
function assertEmittable(name, kind, c) {
  const allowed = new Set(ALLOWED[kind]);
  const stray = declaredFields2(c).filter((f) => !allowed.has(f));
  if (!stray.length) return;
  throw new ProcessError(
    `process "${name}" is a ${kind} and cannot declare: ${stray.join(", ")}
  A ${kind} runs as a Cloud Run ${PRIMITIVE[kind]}, which has no such setting \u2014 the deploy would accept ${stray.length === 1 ? "it" : "them"} and ignore ${stray.length === 1 ? "it" : "them"}.`
  );
}
function positive(v, field, name) {
  if (v === void 0) return void 0;
  if (!Number.isInteger(v) || v < 1) {
    throw new ProcessError(`process "${name}": ${field} must be a whole number of 1 or more (got ${JSON.stringify(v)})`);
  }
  return v;
}
function resolveProcess(name, c) {
  const command = (c.command ?? "").trim();
  if (!command) throw new ProcessError(`process "${name}" has no command`);
  const kind = deriveKind(name, c);
  assertEmittable(name, kind, c);
  const declared = declaredFields2(c);
  const base = { name, command, declared };
  const memory = c.memory ?? DEFAULT_SCALE.memory;
  const cpu = c.cpu ?? DEFAULT_SCALE.cpu;
  if (kind === "web") {
    return {
      ...base,
      kind,
      visibility: c.visibility ?? "public",
      health: c.health ?? { path: "/", expect: 200 },
      // Through withScale so the undefined-dropping rule holds here too: spreading
      // a partial over DEFAULT_SCALE overwrites defaults with undefined, which is
      // how `--concurrency undefined` once reached gcloud.
      scale: withScale({
        memory: c.memory,
        cpu: c.cpu,
        maxInstances: c.maxInstances,
        timeout: c.timeout,
        concurrency: c.concurrency,
        cpuBoost: c.cpuBoost
      }),
      shutdownGrace: positive(c.shutdownGrace, "shutdownGrace", name)
    };
  }
  if (kind === "worker") {
    return {
      ...base,
      kind,
      instances: positive(c.instances, "instances", name) ?? DEFAULT_INSTANCES,
      memory,
      cpu,
      shutdownGrace: positive(c.shutdownGrace, "shutdownGrace", name)
    };
  }
  if (kind === "cron" && !c.schedule?.trim()) {
    throw new ProcessError(`process "${name}" is a cron and needs a "schedule" \u2014 a cron expression like "0 3 * * *"`);
  }
  return {
    ...base,
    kind,
    schedule: c.schedule?.trim(),
    timezone: c.timezone?.trim(),
    memory,
    cpu,
    taskTimeout: positive(c.taskTimeout, "taskTimeout", name) ?? DEFAULT_TASK_TIMEOUT,
    retries: c.retries ?? DEFAULT_RETRIES
  };
}
function mergeProcfile(declared, procfile) {
  const out = {};
  for (const entry of procfile ?? []) out[entry.name] = { command: entry.command };
  for (const [name, cfg] of Object.entries(declared ?? {})) {
    const fromFile = out[name];
    if (fromFile && cfg.command && cfg.command.trim() !== fromFile.command) {
      throw new ProcessError(
        `process "${name}" has one command in Procfile and a different one in supersonic.json:
  Procfile:        ${fromFile.command}
  supersonic.json: ${cfg.command}
  Keep one. Leave "command" out of supersonic.json to use the Procfile's.`
      );
    }
    out[name] = { ...fromFile, ...cfg };
  }
  return out;
}
function resolveProcesses(configs) {
  const resolved = Object.entries(configs).map(([name, c]) => resolveProcess(name, c));
  const webs = resolved.filter((p) => p.kind === "web");
  if (webs.length > 1) {
    throw new ProcessError(
      `a service has ${webs.length} web processes (${webs.map((p) => p.name).join(", ")}) \u2014 only one can answer on the service's address. Split them into two services, each with its own path.`
    );
  }
  const releases = resolved.filter((p) => p.kind === "release");
  if (releases.length > 1) {
    throw new ProcessError(
      `a service has ${releases.length} release processes (${releases.map((p) => p.name).join(", ")}) \u2014 the release phase runs exactly once, before traffic.`
    );
  }
  return [...webs, ...resolved.filter((p) => p.kind !== "web")];
}

// lib/process-plan.ts
function isServiceless(declared) {
  return declared.length > 0 && !declared.some((p) => p.kind === "web");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CONFIG_FILENAME,
  ConfigError,
  DEFAULT_SCALE,
  PRIMITIVE,
  ProcessError,
  ProcfileError,
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
  isServiceless,
  mergeProcfile,
  missingSecrets,
  normalizeLanguage,
  parseAppConfig,
  parseProcfile,
  platformOwned,
  primaryService,
  pythonInstall,
  pythonModule,
  readAppConfig,
  readProcfile,
  readRepoFacts,
  resolve,
  resolveProcesses,
  runtimeMismatch,
  serviceFor,
  servicePath,
  unemittable,
  validate
});
