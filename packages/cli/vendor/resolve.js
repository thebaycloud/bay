// supersonic-vendor-stamp 920d377cdf077931
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
  detect: () => detect,
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
  resolve: () => resolve2,
  resolveProcesses: () => resolveProcesses,
  runtimeMismatch: () => runtimeMismatch,
  serviceFor: () => serviceFor,
  serviceLanguage: () => serviceLanguage,
  servicePath: () => servicePath,
  unemittable: () => unemittable,
  validate: () => validate
});
module.exports = __toCommonJS(resolver_entry_exports);

// lib/resolve.ts
var import_node_fs7 = require("node:fs");
var import_node_path7 = require("node:path");

// lib/app-config.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// lib/db-address.ts
var CLOUD_RUN_DB = { host: "127.0.0.1", port: "5432" };

// lib/lanes.ts
var SERVICE_LANES = ["container"];
var ALL_LANES = ["static", ...SERVICE_LANES];
var DB_HOST = CLOUD_RUN_DB.host;
var DB_PORT = CLOUD_RUN_DB.port;
var CLOUD_SQL_PROXY_IMAGE = process.env.CLOUD_SQL_PROXY_IMAGE ?? "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1";
function databaseEnv(db, at = CLOUD_RUN_DB) {
  return [
    `DATABASE_URL=${db.databaseUrl}`,
    `POSTGRES_SERVER=${at.host}`,
    `POSTGRES_HOST=${at.host}`,
    `POSTGRES_PORT=${at.port}`,
    `POSTGRES_USER=${db.user}`,
    `POSTGRES_PASSWORD=${db.password}`,
    `POSTGRES_DB=${db.dbName}`,
    `PGHOST=${at.host}`,
    `PGPORT=${at.port}`,
    `PGUSER=${db.user}`,
    `PGPASSWORD=${db.password}`,
    `PGDATABASE=${db.dbName}`,
    `DB_HOST=${at.host}`,
    `DB_PORT=${at.port}`,
    `DB_USER=${db.user}`,
    `DB_PASSWORD=${db.password}`,
    `DB_NAME=${db.dbName}`
  ];
}
function databaseEnvNames() {
  return databaseEnv({ databaseUrl: "", user: "", password: "", dbName: "" }).map((pair2) => pair2.slice(0, pair2.indexOf("=")));
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
    const known = ["database", "bucket", "redis", "elasticsearch"];
    for (const u of uses ?? []) {
      if (!known.includes(u)) {
        throw new ConfigError(`${where}.uses: "${u}" is not a resource \u2014 expected one of ${known.join(", ")}`);
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
var import_node_fs6 = require("node:fs");
var import_node_path6 = require("node:path");

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

// lib/detect.ts
var import_node_fs5 = require("node:fs");
var import_node_path5 = require("node:path");

// lib/procfile.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
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
  const path = (0, import_node_path3.join)(dir, PROCFILE);
  if (!(0, import_node_fs3.existsSync)(path)) return null;
  return parseProcfile((0, import_node_fs3.readFileSync)(path, "utf8"));
}

// lib/repo-runtime.ts
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");

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

// lib/repo-runtime.ts
var RUNTIME_LANGUAGES = ["python", "node", "go", "rust", "ruby", "php", "java"];
var NO_PIN = /^(system|latest|current|lts|stable|nightly|beta|node|default|\*)$|^(ref|path|pypy|graalvm|truffleruby|jruby|conda|miniconda|anaconda|mamba)[:@-]?/i;
var PLATFORM_DEFAULT_VERSION = {
  python: "3.14",
  node: "24",
  go: "1.24",
  rust: "1.85",
  ruby: "3.4",
  php: "8.4",
  java: "21"
};
var KNOWN_VERSIONS = {
  python: ["3.8", "3.9", "3.10", "3.11", "3.12", "3.13", "3.14"],
  // Even majors are the LTS lines, which is what `lts/*` and `lts/<codename>` mean.
  node: ["18", "20", "22", "24"],
  go: ["1.21", "1.22", "1.23", "1.24"],
  rust: ["1.78", "1.79", "1.80", "1.81", "1.82", "1.83", "1.84", "1.85"],
  ruby: ["3.0", "3.1", "3.2", "3.3", "3.4"],
  php: ["8.0", "8.1", "8.2", "8.3", "8.4"],
  // eclipse-temurin publishes majors and full builds; only the majors are stable
  // names. See `javaTag` for why every Java answer is reduced to one.
  java: ["8", "11", "17", "21", "24", "25"]
};
var NODE_LTS_CODENAMES = {
  argon: "4",
  boron: "6",
  carbon: "8",
  dubnium: "10",
  erbium: "12",
  fermium: "14",
  gallium: "16",
  hydrogen: "18",
  iron: "20",
  jod: "22",
  krypton: "24"
};
var NEWEST_NODE_LTS = KNOWN_VERSIONS.node.filter((v) => Number(v) % 2 === 0).at(-1);
var TOOL_ALIASES = {
  python: "python",
  nodejs: "node",
  node: "node",
  golang: "go",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  php: "php",
  java: "java"
};
var RuntimeVersionError = class extends Error {
};
var ZERO = [0, 0, 0];
function parts(v) {
  const m = v.trim().match(/^v?(\d+(?:\.\d+)*)$/);
  return m ? m[1].split(".").map(Number) : null;
}
function ver(p) {
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function bump(p, at) {
  const next = p.slice(0, at + 1);
  next[at] = (next[at] ?? 0) + 1;
  return ver(next);
}
function familySpan(v) {
  const p = parts(v);
  if (!p) return null;
  return { lo: ver(p), loInc: true, hi: bump(p, p.length - 1), hiInc: false };
}
function overlaps(a, b) {
  if (b.hi) {
    const c = cmp(a.lo, b.hi);
    if (c > 0 || c === 0 && !(a.loInc && b.hiInc)) return false;
  }
  if (a.hi) {
    const c = cmp(b.lo, a.hi);
    if (c > 0 || c === 0 && !(b.loInc && a.hiInc)) return false;
  }
  return true;
}
function clauseSpan(clause) {
  const c = clause.trim();
  if (!c) return null;
  const wild = c.match(/^(>=|<=|==|!=|~=|~>|\^|~|=|>|<)?\s*v?(\d+(?:\.\d+)*)\.(?:\*|x)$/i);
  if (wild) {
    const span = familySpan(wild[2]);
    if (!span) return null;
    return wild[1] === "!=" ? { exclude: span } : span;
  }
  const m = c.match(/^(>=|<=|==|!=|~=|~>|\^|~|=|>|<)?\s*v?(\d+(?:\.\d+)*)$/);
  if (!m) return null;
  const op = m[1] ?? "=";
  const p = parts(m[2]);
  const lo = ver(p);
  switch (op) {
    case ">=":
      return { lo, loInc: true, hi: null, hiInc: false };
    case ">":
      return { lo, loInc: false, hi: null, hiInc: false };
    case "<":
      return { lo: ZERO, loInc: true, hi: lo, hiInc: false };
    case "<=":
      return { lo: ZERO, loInc: true, hi: lo, hiInc: true };
    case "=":
    case "==":
      return familySpan(m[2]);
    case "!=": {
      const span = familySpan(m[2]);
      return span ? { exclude: span } : null;
    }
    // npm: `^1.2.3` → <2.0.0, but `^0.2.3` → <0.3.0. Nobody pins a runtime below
    // 1.0, and the rule is cheap enough to get right rather than to assume.
    case "^": {
      const at = p[0] === 0 ? p[1] === 0 ? 2 : 1 : 0;
      return { lo, loInc: true, hi: bump(p, Math.min(at, p.length - 1)), hiInc: false };
    }
    // npm tilde: `~1.2.3` and `~1.2` both stop at 1.3.0; `~1` stops at 2.0.0.
    case "~":
      return { lo, loInc: true, hi: bump(p, p.length >= 2 ? 1 : 0), hiInc: false };
    // PEP 440 `~=` and Ruby's pessimistic `~>` are the same rule: drop the last
    // component that was written, and bump the one before it.
    case "~=":
    case "~>":
      return { lo, loInc: true, hi: bump(p, Math.max(0, p.length - 2)), hiInc: false };
    default:
      return null;
  }
}
function hyphenSpan(alt) {
  const m = alt.match(/^v?(\d+(?:\.\d+)*)(?:\.(?:\*|x))*\s+-\s+v?(\d+(?:\.\d+)*)(?:\.(?:\*|x))*$/i);
  if (!m) return null;
  const lo = parts(m[1]);
  const hi = familySpan(m[2]);
  if (!lo || !hi) return null;
  return { lo: ver(lo), loInc: true, hi: hi.hi, hiInc: false };
}
function satisfying(language, spec) {
  const alternatives = spec.split("||").map((s) => s.trim()).filter(Boolean);
  if (!alternatives.length) return null;
  const accepted = /* @__PURE__ */ new Set();
  for (const alt of alternatives) {
    const hyphen = hyphenSpan(alt);
    if (hyphen) {
      for (const known of KNOWN_VERSIONS[language]) {
        if (overlaps(familySpan(known), hyphen)) accepted.add(known);
      }
      continue;
    }
    const clauses = alt.split(/\s*,\s*|\s+/).filter(Boolean);
    const spans = [];
    const excluded = [];
    for (const clause of clauses) {
      const parsed = clauseSpan(clause);
      if (!parsed) return null;
      if ("exclude" in parsed) excluded.push(parsed.exclude);
      else spans.push(parsed);
    }
    if (!spans.length && !excluded.length) return null;
    for (const known of KNOWN_VERSIONS[language]) {
      const fam = familySpan(known);
      if (!spans.every((s) => overlaps(fam, s))) continue;
      if (excluded.some((e) => cmp(e.lo, fam.lo) <= 0 && e.hi && fam.hi && cmp(fam.hi, e.hi) <= 0)) continue;
      accepted.add(known);
    }
  }
  return KNOWN_VERSIONS[language].filter((v) => accepted.has(v));
}
function isExact(spec) {
  return /^v?\d+(\.\d+)*$/.test(spec.trim());
}
var FILE_READS = [
  ["toolVersions", [".tool-versions"]],
  ["miseToml", ["mise.toml", ".mise.toml"]],
  ["pythonVersion", [".python-version"]],
  ["runtimeTxt", ["runtime.txt"]],
  ["pyproject", ["pyproject.toml"]],
  ["nvmrc", [".nvmrc"]],
  ["nodeVersion", [".node-version"]],
  ["goMod", ["go.mod"]],
  ["rustToolchainToml", ["rust-toolchain.toml"]],
  ["rustToolchain", ["rust-toolchain"]],
  ["rubyVersion", [".ruby-version"]],
  ["gemfile", ["Gemfile"]],
  ["sdkmanrc", [".sdkmanrc"]],
  ["pomXml", ["pom.xml"]],
  ["buildGradle", ["build.gradle", "build.gradle.kts"]]
];
function readRuntimeFiles(dir) {
  const text = (names2) => {
    for (const n of names2) {
      const p = (0, import_node_path4.join)(dir, n);
      try {
        if ((0, import_node_fs4.existsSync)(p)) return (0, import_node_fs4.readFileSync)(p, "utf8");
      } catch {
      }
    }
    return null;
  };
  const json = (name) => {
    try {
      return JSON.parse((0, import_node_fs4.readFileSync)((0, import_node_path4.join)(dir, name), "utf8"));
    } catch {
      return null;
    }
  };
  const files = {};
  for (const [key, names2] of FILE_READS) files[key] = text(names2);
  files.packageJson = json("package.json");
  files.composerJson = json("composer.json");
  return files;
}
var firstLine = (v) => (v ?? "").trim().split("\n")[0].trim();
function parseToolVersions(text) {
  const out = /* @__PURE__ */ new Map();
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [tool, ...rest] = line.split(/\s+/);
    const language = TOOL_ALIASES[tool?.toLowerCase()];
    const value = rest[0];
    if (language && value && !out.has(language)) out.set(language, value);
  }
  return out;
}
function parseMiseTools(text) {
  const out = /* @__PURE__ */ new Map();
  const body = text ?? "";
  const start = body.search(/^\s*\[tools\]\s*$/m);
  if (start === -1) return out;
  const rest = body.slice(start).split("\n").slice(1);
  for (const raw of rest) {
    const line = raw.split("#")[0].trim();
    if (/^\[/.test(line)) break;
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const language = TOOL_ALIASES[m[1].toLowerCase()];
    if (!language || out.has(language)) continue;
    const value = m[2].match(/["']([^"']+)["']/)?.[1];
    if (value) out.set(language, value);
  }
  return out;
}
function javaMajor(raw) {
  let v = raw.trim();
  v = v.replace(/^(?:temurin|openjdk|adoptopenjdk|graalvm|corretto|zulu|liberica|oracle|sapmachine|semeru)[-@]/i, "");
  v = v.replace(/-(?:tem|open|amzn|zulu|librca|ms|sem|graal|oracle|sapmchn)$/i, "");
  v = v.replace(/^JavaVersion\.VERSION_/i, "").replace(/^VERSION_/i, "");
  v = v.replace(/_/g, ".");
  const p = parts(v);
  if (!p) return null;
  const major = p[0] === 1 && p.length > 1 ? p[1] : p[0];
  return String(major);
}
var RUST_CHANNEL = /^(stable|beta|nightly)(-\d{4}-\d{2}-\d{2})?$/i;
function runtimePins(f) {
  const pins = [];
  const add = (language, raw, spec, from, kind = "exact") => {
    const trimmed = spec.trim();
    if (!trimmed || NO_PIN.test(trimmed)) return;
    pins.push({ language, raw, spec: trimmed, from, kind });
  };
  const addFromVersionManager = (tools, from) => {
    for (const [language, value] of tools) {
      if (language === "rust" && RUST_CHANNEL.test(value)) continue;
      const spec = language === "java" ? javaMajor(value) : value.replace(/^v/, "");
      if (spec) add(language, value, spec, from);
    }
  };
  addFromVersionManager(parseToolVersions(f.toolVersions), ".tool-versions");
  addFromVersionManager(parseMiseTools(f.miseToml), "mise.toml");
  const pv = firstLine(f.pythonVersion);
  if (pv) add("python", pv, pv, ".python-version");
  const rt = firstLine(f.runtimeTxt);
  if (/^python-/i.test(rt)) add("python", rt, rt.replace(/^python-/i, ""), "runtime.txt");
  const requiresPython = f.pyproject?.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (requiresPython) add("python", requiresPython, requiresPython, "pyproject.toml requires-python", "range");
  const poetryTable = f.pyproject?.match(/^[ \t]*\[tool\.poetry\.dependencies\][ \t]*\r?\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/m)?.[1];
  const poetryPython = poetryTable?.match(/^\s*python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (poetryPython) {
    add("python", poetryPython, poetryPython, "pyproject.toml [tool.poetry.dependencies] python", "range");
  }
  const nvm = firstLine(f.nvmrc);
  if (nvm) {
    const codename = nvm.toLowerCase().match(/^lts\/(.+)$/)?.[1];
    const lts = codename === "*" ? NEWEST_NODE_LTS : codename ? NODE_LTS_CODENAMES[codename] : null;
    if (codename) {
      if (lts) add("node", nvm, lts, ".nvmrc");
    } else add("node", nvm, nvm.replace(/^v/, ""), ".nvmrc");
  }
  const nodeVersion = firstLine(f.nodeVersion);
  if (nodeVersion) add("node", nodeVersion, nodeVersion.replace(/^v/, ""), ".node-version");
  const pkg = f.packageJson ?? null;
  if (pkg?.volta?.node) add("node", pkg.volta.node, pkg.volta.node.replace(/^v/, ""), "package.json volta.node");
  if (pkg?.engines?.node) add("node", pkg.engines.node, pkg.engines.node, "package.json engines.node", "range");
  const toolchain = f.goMod?.match(/^\s*toolchain\s+go?([0-9][^\s]*)/m)?.[1];
  if (toolchain) add("go", `go${toolchain}`, toolchain, "go.mod toolchain");
  const goLine = f.goMod?.match(/^\s*go\s+([0-9][^\s]*)/m)?.[1];
  if (goLine) add("go", goLine, goLine, "go.mod");
  const channel = f.rustToolchainToml?.match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1];
  if (channel && !RUST_CHANNEL.test(channel.trim())) add("rust", channel, channel, "rust-toolchain.toml");
  const bare = firstLine(f.rustToolchain);
  if (bare && !RUST_CHANNEL.test(bare)) add("rust", bare, bare, "rust-toolchain");
  const rubyVersion = firstLine(f.rubyVersion);
  if (rubyVersion) add("ruby", rubyVersion, rubyVersion.replace(/^ruby-/i, ""), ".ruby-version");
  const gemfileRuby = f.gemfile?.match(/^\s*ruby\s+["']([^"']+)["']/m)?.[1];
  if (gemfileRuby) add("ruby", gemfileRuby, gemfileRuby, "Gemfile", "range");
  const composer = f.composerJson ?? null;
  const platformPhp = composer?.config?.platform?.php;
  if (platformPhp) add("php", platformPhp, platformPhp, "composer.json config.platform.php");
  const requirePhp = composer?.require?.php;
  if (requirePhp) add("php", requirePhp, requirePhp, "composer.json require.php", "range");
  const sdkman = f.sdkmanrc?.match(/^\s*java\s*=\s*(.+)$/m)?.[1];
  if (sdkman) {
    const major = javaMajor(sdkman);
    if (major) add("java", sdkman.trim(), major, ".sdkmanrc");
  }
  for (const field of ["maven.compiler.release", "java.version", "maven.compiler.source", "maven.compiler.target"]) {
    const found = f.pomXml?.match(new RegExp(`<${field.replace(/\./g, "\\.")}>([^<]+)<`))?.[1];
    if (!found) continue;
    const major = javaMajor(found);
    if (major) {
      add("java", found.trim(), major, `pom.xml ${field}`);
      break;
    }
  }
  const gradle = f.buildGradle?.match(/JavaLanguageVersion\.of\((\d+)\)/)?.[1] ?? f.buildGradle?.match(/jvmToolchain\((\d+)\)/)?.[1] ?? f.buildGradle?.match(/(?:source|target)Compatibility\s*=?\s*["']?([A-Za-z0-9_.]+)["']?/)?.[1];
  if (gradle) {
    const major = javaMajor(gradle);
    if (major) add("java", gradle.trim(), major, "build.gradle");
  }
  return pins;
}
function pinFor(pins, language) {
  return pins.find((p) => p.language === language) ?? null;
}
function assertValidTag(tag, where) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    throw new RuntimeVersionError(
      `${where} asks for "${tag}", which is not a version an image can be pulled by.
  Write a concrete version there (like "3.12"), or set "build": { "image": "\u2026" } in supersonic.json to choose the base image yourself.`
    );
  }
}
function resolveRuntime(language, pin) {
  const fallback = (why) => ({
    language,
    version: PLATFORM_DEFAULT_VERSION[language],
    versionFrom: why
  });
  if (!pin) return fallback("platform default");
  const spec = pin.spec.trim();
  if (pin.kind === "exact" && !isExact(spec)) {
    throw new RuntimeVersionError(
      `${pin.from} says "${pin.raw.trim()}", which is not a version.
  Write a plain version there (like "${PLATFORM_DEFAULT_VERSION[language]}"), or set "build": { "image": "\u2026" } in supersonic.json to choose the base image yourself.`
    );
  }
  if (isExact(spec)) {
    const version = spec.replace(/^v/, "");
    assertValidTag(version, pin.from);
    return {
      language,
      version,
      versionFrom: version === pin.raw.trim() ? pin.from : `${pin.from} ${pin.raw.trim()} \u2192 ${version}`
    };
  }
  const options = satisfying(language, spec);
  if (!options) {
    return fallback(`platform default \u2014 ${pin.from} says "${pin.raw.trim()}", which is not a version range we read`);
  }
  const chosen = options.at(-1);
  if (!chosen) {
    return fallback(
      `platform default \u2014 ${pin.from} asks for "${pin.raw.trim()}" and no ${language} we know of satisfies it`
    );
  }
  assertValidTag(chosen, pin.from);
  return { language, version: chosen, versionFrom: `${pin.from} ${pin.raw.trim()} \u2192 ${chosen}` };
}
var trim = (v) => (v ?? "").trim().split("\n")[0].trim();
function repoRuntime(f) {
  const pv = trim(f.pythonVersion);
  if (pv) return { language: "python", spec: pv, from: ".python-version" };
  const rt = trim(f.runtimeTxt);
  if (/^python-/i.test(rt)) return { language: "python", spec: rt.replace(/^python-/i, ""), from: "runtime.txt" };
  const nvm = trim(f.nvmrc);
  if (nvm) return { language: "node", spec: nvm.replace(/^v/, ""), from: ".nvmrc" };
  const requires = f.pyproject?.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
  if (requires) return { language: "python", spec: requires.trim(), from: "pyproject.toml" };
  const engines = f.packageJson?.engines?.node;
  if (engines) return { language: "node", spec: engines.trim(), from: "package.json" };
  return null;
}
function pair(v) {
  const m = v.match(/^(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}
function ge(have, need) {
  return have[0] > need[0] || have[0] === need[0] && have[1] >= need[1];
}
function runnerServes(r) {
  const have = pair(RUNTIME_VERSIONS[r.language]);
  if (!have) return false;
  const spec = r.spec.trim();
  if (/^\d+(\.\d+)*$/.test(spec)) {
    const want = pair(spec);
    return spec.includes(".") ? have[0] === want[0] && have[1] === want[1] : have[0] === want[0];
  }
  const clauses = spec.split(/\s*,\s*|\s+/).filter(Boolean);
  if (!clauses.length) return false;
  for (const c of clauses) {
    const m = c.match(/^(>=|<=|==|!=|~=|\^|>|<)?\s*v?(\d+(?:\.\d+)*)$/);
    if (!m) return false;
    const [, op = ">=", v] = m;
    const want = pair(v);
    const exact = have[0] === want[0] && have[1] === want[1];
    switch (op) {
      case ">=":
        if (!ge(have, want)) return false;
        break;
      case ">":
        if (ge(want, have)) return false;
        break;
      case "<":
        if (ge(have, want)) return false;
        break;
      case "<=":
        if (!ge(want, have) && !exact) return false;
        break;
      case "==":
        if (!exact) return false;
        break;
      case "!=":
        if (exact) return false;
        break;
      // `~=3.11` and `^3.11` both mean "this minor, or compatible with it", and
      // the honest answer for a runner pinned to one minor is only yes when it IS
      // that minor.
      case "~=":
      case "^":
        if (!exact) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

// lib/detect.ts
function yarnInstall(dir) {
  const lock = readText(dir, "yarn.lock") ?? "";
  const berry = /^__metadata:/m.test(lock) || /^\s{2}version:\s*\d/m.test(lock);
  return berry ? "corepack enable && yarn install --immutable" : "corepack enable && yarn install --frozen-lockfile";
}
var PACKAGE_RULES = {
  python: [
    // `uv sync` builds the local project, and the cached layer runs before the
    // source is copied. `--no-install-project` is what lets it be cached at all.
    {
      file: "uv.lock",
      manager: "uv",
      install: "pip install --no-cache-dir uv && uv sync --frozen --no-dev --no-install-project",
      installProject: "uv sync --frozen --no-dev"
    },
    // `POETRY_VIRTUALENVS_CREATE=false` is not a preference, it is what makes the
    // installed packages reachable. Poetry's default is a venv under
    // `~/.cache/pypoetry/virtualenvs/<hash>` — a path nothing in the image knows,
    // and one this Dockerfile cannot put on `PATH` because the hash is computed at
    // install time. So the build was green, every dependency was installed, and
    // the container exited 127 on its own entry point. Installing into the image's
    // system python is what a container wants anyway: the isolation a venv buys is
    // already the container's job.
    {
      file: "poetry.lock",
      manager: "poetry",
      install: "pip install --no-cache-dir poetry && POETRY_VIRTUALENVS_CREATE=false poetry install --no-root --only main"
    },
    {
      file: "Pipfile.lock",
      manager: "pipenv",
      install: "pip install --no-cache-dir pipenv && pipenv install --deploy --system"
    },
    {
      file: "requirements.txt",
      manager: "pip",
      install: "pip install --no-cache-dir -r requirements.txt"
    },
    // No `--no-install-project` equivalent exists for `pip install .`, so this one
    // installs after `COPY . .` and forgoes the cached layer. Stated rather than
    // emitted as a Dockerfile that cannot build.
    { file: "pyproject.toml", manager: "pip", installProject: "pip install --no-cache-dir ." }
  ],
  node: [
    { file: "pnpm-lock.yaml", manager: "pnpm", install: "corepack enable && pnpm install --frozen-lockfile" },
    { file: "yarn.lock", manager: "yarn", installFor: yarnInstall },
    // bun >= 1.2 writes a TEXT lockfile. Listing only `bun.lockb` drops every
    // modern bun repo to `npm install`, which cannot install a bun workspace.
    { file: "bun.lock", manager: "bun", install: "bun install --frozen-lockfile" },
    { file: "bun.lockb", manager: "bun", install: "bun install --frozen-lockfile" },
    { file: "package-lock.json", manager: "npm", install: "npm ci" },
    // `npm ci` refuses to run without a lockfile, and a lockfile-less project is
    // the common case for the people this platform is for.
    { file: "package.json", manager: "npm", install: "npm install" }
  ],
  go: [
    { file: "go.sum", manager: "go", install: "go mod download" },
    { file: "go.mod", manager: "go", install: "go mod download" }
  ],
  rust: [
    // cargo resolves and compiles in one step; there is no install to cache apart
    // from the build itself.
    { file: "Cargo.lock", manager: "cargo" },
    { file: "Cargo.toml", manager: "cargo" }
  ],
  ruby: [
    { file: "Gemfile.lock", manager: "bundler", install: "bundle install --without development test" },
    { file: "Gemfile", manager: "bundler", install: "bundle install --without development test" }
  ],
  php: [
    { file: "composer.lock", manager: "composer", install: "composer install --no-dev --optimize-autoloader" },
    { file: "composer.json", manager: "composer", install: "composer install --no-dev --optimize-autoloader" }
  ],
  // Java is the row docs/MAKE-DEPLOYS-WORK.md Part 8 names as missing: the
  // manifest COPY has no `pom.xml` or `build.gradle*` either, so "now covers Go,
  // Ruby, Java and PHP" was false for Java out of the box. Both halves are here.
  java: [
    { file: "pom.xml", manager: "maven", install: "mvn -B -q -DskipTests dependency:go-offline" },
    { file: "build.gradle.kts", manager: "gradle" },
    { file: "build.gradle", manager: "gradle" }
  ]
};
var PACKAGE_MANIFESTS = [
  ...new Set(RUNTIME_LANGUAGES.flatMap((l) => PACKAGE_RULES[l].map((r) => r.file)))
];
var readText = (dir, file) => {
  try {
    const p = (0, import_node_path5.join)(dir, file);
    return (0, import_node_fs5.existsSync)(p) ? (0, import_node_fs5.readFileSync)(p, "utf8") : null;
  } catch {
    return null;
  }
};
var readJson = (dir, file) => {
  const raw = readText(dir, file);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};
var hasFile = (dir, file) => {
  try {
    return (0, import_node_fs5.existsSync)((0, import_node_path5.join)(dir, file));
  } catch {
    return false;
  }
};
function nodeDeps(pkg) {
  const p = pkg ?? {};
  return /* @__PURE__ */ new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]);
}
function pythonDepsText(dir) {
  return [
    readText(dir, "requirements.txt") ?? "",
    readText(dir, "pyproject.toml") ?? "",
    readText(dir, "Pipfile") ?? ""
  ].join("\n").toLowerCase();
}
var CONFIGS = {
  next: ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts"],
  astro: ["astro.config.mjs", "astro.config.js", "astro.config.cjs", "astro.config.ts"],
  svelte: ["svelte.config.js", "svelte.config.mjs", "svelte.config.ts"]
};
function dirFacts(dir, rel) {
  const pkg = readJson(dir, "package.json");
  const readFirst = (names2) => {
    for (const n of names2) {
      const s = readText(dir, n);
      if (s) return s;
    }
    return null;
  };
  return {
    dir,
    rel,
    pkg,
    deps: nodeDeps(pkg),
    pythonText: pythonDepsText(dir),
    nextConfig: readFirst(CONFIGS.next),
    astroConfig: readFirst(CONFIGS.astro),
    svelteConfig: readFirst(CONFIGS.svelte),
    gemfile: readText(dir, "Gemfile"),
    composer: readJson(dir, "composer.json"),
    cargo: readText(dir, "Cargo.toml")
  };
}
function astroHasAdapter(src) {
  const s = src ?? "";
  return /adapter\s*:/.test(s) || /@astrojs\/(node|vercel|netlify|cloudflare|deno)/.test(s);
}
function nextIsExport(src) {
  return /output\s*:\s*["'`]export["'`]/.test(src ?? "");
}
function svelteHasNodeAdapter(f) {
  return f.deps.has("@sveltejs/adapter-node") || /@sveltejs\/adapter-node/.test(f.svelteConfig ?? "");
}
function djangoPackage(dir) {
  const manage = readText(dir, "manage.py") ?? "";
  const declared = manage.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1];
  if (declared) return declared.split(".")[0];
  try {
    for (const e of (0, import_node_fs5.readdirSync)(dir, { withFileTypes: true })) {
      if (e.isDirectory() && (0, import_node_fs5.existsSync)((0, import_node_path5.join)(dir, e.name, "wsgi.py"))) return e.name;
    }
  } catch {
  }
  return null;
}
function cargoBinary(src) {
  const pkgSection = (src ?? "").split(/^\s*\[/m).find((s) => s.startsWith("package]"));
  return pkgSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
}
var FRAMEWORK_START = [
  {
    when: (f) => f.deps.has("next") || Boolean(f.nextConfig),
    start: (f) => nextIsExport(f.nextConfig) ? null : "next start -p $PORT",
    token: "next"
  },
  {
    when: (f) => f.deps.has("nuxt") || hasFile(f.dir, "nuxt.config.ts") || hasFile(f.dir, "nuxt.config.js"),
    start: () => "node .output/server/index.mjs",
    token: "nuxt"
  },
  // React Router 7 is Remix; the framework kept the deploy shape and changed the
  // name, and both spellings are in the wild.
  {
    when: (f) => f.deps.has("@react-router/serve") || f.deps.has("@react-router/node") || f.deps.has("@remix-run/serve") || f.deps.has("@remix-run/node"),
    start: () => "react-router-serve ./build/server/index.js",
    token: "remix"
  },
  {
    when: (f) => f.deps.has("astro") || Boolean(f.astroConfig),
    start: (f) => astroHasAdapter(f.astroConfig) ? "node ./dist/server/entry.mjs" : null,
    token: "astro"
  },
  {
    when: (f) => f.deps.has("@sveltejs/kit") || Boolean(f.svelteConfig),
    start: (f) => svelteHasNodeAdapter(f) ? "node build" : null,
    token: "svelte"
  },
  { when: (f) => f.deps.has("@nestjs/core"), start: () => "node dist/main.js", token: "nest" },
  {
    when: (f) => hasFile(f.dir, "manage.py"),
    start: (f) => `gunicorn ${djangoPackage(f.dir) ?? "config"}.wsgi:application -b :$PORT`,
    extra: "gunicorn",
    token: "django"
  },
  {
    when: (f) => hasFile(f.dir, "main.py") && /fastapi/.test(f.pythonText),
    start: () => "uvicorn main:app --host 0.0.0.0 --port $PORT",
    extra: "uvicorn",
    token: "fastapi"
  },
  {
    when: (f) => hasFile(f.dir, "app/main.py") && /fastapi/.test(f.pythonText),
    start: () => "uvicorn app.main:app --host 0.0.0.0 --port $PORT",
    extra: "uvicorn",
    token: "fastapi"
  },
  {
    when: (f) => hasFile(f.dir, "app.py") && /flask/.test(f.pythonText),
    start: () => "gunicorn app:app -b :$PORT",
    extra: "gunicorn",
    token: "flask"
  },
  { when: (f) => hasFile(f.dir, "wsgi.py"), start: () => "gunicorn wsgi:app -b :$PORT", extra: "gunicorn" },
  {
    when: (f) => Boolean(f.gemfile) && /rails/i.test(f.gemfile ?? ""),
    start: () => "bundle exec rails s -b 0.0.0.0 -p $PORT",
    token: "rails"
  },
  { when: (f) => hasFile(f.dir, "config.ru"), start: () => "bundle exec rackup -p $PORT -o 0.0.0.0" },
  // Only when there is a binary to run. With several main packages and no
  // convention to choose between them, nothing builds `/app/server` — so naming
  // it as the start command would be a container that exits 127 on a file the
  // build never produced.
  { when: (f) => hasFile(f.dir, "go.mod"), start: (f) => goMainPackage(f.dir).pattern ? "/app/server" : null },
  {
    when: (f) => Boolean(f.cargo),
    start: (f) => `/app/target/release/${cargoBinary(f.cargo) ?? "app"}`
  },
  // The two PHP rows are DEVELOPMENT servers. `php -S` and `php artisan serve` are
  // single-threaded and serialise requests, and Cloud Run's default concurrency is
  // 80 — so a burst of 80 requests queues behind one worker and the app looks
  // hung. They are here as a first-deploy default on the explicit condition that
  // `phpConcurrency` below pins concurrency to 1 for them; replacing them with
  // frankenphp or php-fpm+nginx is the real fix and is not this step's work.
  {
    when: (f) => hasFile(f.dir, "artisan"),
    start: () => "php artisan serve --host 0.0.0.0 --port $PORT",
    token: "laravel"
  },
  { when: (f) => hasFile(f.dir, "index.php"), start: () => "php -S 0.0.0.0:$PORT" }
];
var PYTHON_ENTRIES = ["main.py", "app/main.py", "src/main.py", "app.py", "api/main.py", "src/app.py"];
var PYTHON_RUNNABLE = [...PYTHON_ENTRIES, "manage.py", "wsgi.py", "asgi.py"];
function bindToPort(cmd) {
  return cmd.replace(/(--port[= ])\d+/g, "$1$PORT").replace(/(--bind[= ]\S*?:)\d+/g, "$1$PORT").replace(/(-b\s+\S*?:)\d+/g, "$1$PORT").replace(/(-p\s+)\d+/g, "$1$PORT");
}
function pythonModule(serviceDir) {
  for (const entry of PYTHON_ENTRIES) {
    if ((0, import_node_fs5.existsSync)((0, import_node_path5.join)(serviceDir, entry))) return entry.replace(/\.py$/, "").split("/").join(".");
  }
  return null;
}
function pythonInstall(serviceDir, detected) {
  const rule = PACKAGE_RULES.python.find((r) => (0, import_node_fs5.existsSync)((0, import_node_path5.join)(serviceDir, r.file)));
  if (!rule) return void 0;
  if (rule.file === "requirements.txt" && detected) return detected;
  const full = [rule.install, rule.installProject].filter(Boolean).join(" && ");
  return full || void 0;
}
function serviceLanguage(language, isStatic = false) {
  if (isStatic) return "static";
  const l = (language ?? "").toLowerCase();
  if (l.startsWith("python")) return "python";
  if (l === "node" || /^(java)?script|^typescript/.test(l)) return "node";
  if (l === "static") return "static";
  return "other";
}
var NEEDS = [
  { when: (f) => f.deps.has("canvas"), packages: ["libcairo2-dev", "libpango1.0-dev", "libjpeg-dev"] },
  { when: (f) => /(^|\n|\s)mysqlclient/.test(f.pythonText), packages: ["default-libmysqlclient-dev", "pkg-config"] },
  { when: (f) => /(^|\n|\s)weasyprint/.test(f.pythonText), packages: ["libpango-1.0-0", "libpangoft2-1.0-0"] }
];
function detectDatabase(f) {
  const dep = (n) => f.deps.has(n);
  const py = (n) => new RegExp(`(^|[^\\w-])${n}`, "i").test(f.pythonText);
  if (dep("@prisma/client") || dep("prisma") || hasFile(f.dir, "prisma/schema.prisma")) {
    const provider = readText(f.dir, "prisma/schema.prisma")?.match(/provider\s*=\s*"(\w+)"/)?.[1];
    const engine = provider === "mysql" ? "mysql" : provider === "sqlite" ? "sqlite" : provider === "mongodb" ? "mongodb" : "postgres";
    return { engine, via: "Prisma" };
  }
  if (dep("drizzle-orm")) {
    return { engine: dep("mysql2") ? "mysql" : dep("better-sqlite3") ? "sqlite" : "postgres", via: "Drizzle" };
  }
  if (dep("mongoose")) return { engine: "mongodb", via: "Mongoose" };
  if (dep("typeorm")) return { engine: dep("mysql2") || dep("mysql") ? "mysql" : "postgres", via: "TypeORM" };
  if (dep("sequelize")) return { engine: dep("mysql2") || dep("mysql") ? "mysql" : "postgres", via: "Sequelize" };
  if (dep("pg") || dep("postgres")) return { engine: "postgres", via: "pg" };
  if (dep("mysql2") || dep("mysql")) return { engine: "mysql", via: "mysql" };
  if (py("psycopg2")) return { engine: "postgres", via: "psycopg2" };
  if (py("psycopg")) return { engine: "postgres", via: "psycopg" };
  if (py("asyncpg")) return { engine: "postgres", via: "asyncpg" };
  if (py("django")) return { engine: "postgres", via: "Django ORM" };
  if (py("sqlalchemy")) return { engine: "postgres", via: "SQLAlchemy" };
  if (py("pymysql") || py("mysqlclient")) return { engine: "mysql", via: "mysql" };
  if (py("pymongo")) return { engine: "mongodb", via: "pymongo" };
  const gem = f.gemfile ?? "";
  if (/^\s*gem\s+["']pg["']/m.test(gem)) return { engine: "postgres", via: "pg" };
  if (/^\s*gem\s+["']mysql2["']/m.test(gem)) return { engine: "mysql", via: "mysql2" };
  const goMod = readText(f.dir, "go.mod") ?? "";
  if (/github\.com\/lib\/pq|github\.com\/jackc\/pgx/.test(goMod)) return { engine: "postgres", via: "pgx" };
  if (/github\.com\/go-sql-driver\/mysql/.test(goMod)) return { engine: "mysql", via: "go-sql-driver" };
  const require2 = f.composer?.require ?? {};
  if ("laravel/framework" in require2) return { engine: "mysql", via: "Eloquent" };
  return void 0;
}
function detectRelease(f, procfile, config) {
  const declared = config?.release ?? config?.preDeploy ?? config?.processes?.release?.command;
  if (declared?.trim()) return declared.trim();
  const fromProcfile = procfile?.find((e) => e.name === "release")?.command;
  if (fromProcfile?.trim()) return fromProcfile.trim();
  if (hasFile(f.dir, "manage.py")) return "python manage.py migrate --noinput";
  if (hasFile(f.dir, "alembic.ini")) return "alembic upgrade head";
  if (hasFile(f.dir, "prisma/schema.prisma")) return "npx --no-install prisma migrate deploy";
  if (f.gemfile && /rails/i.test(f.gemfile)) return "bundle exec rails db:migrate";
  return void 0;
}
var GO_SERVER_DIRS = ["server", "api", "web", "app", "service", "daemon", "http"];
function goMainPackage(dir) {
  const mains = [];
  const walk = (abs, rel, depth) => {
    if (depth > 3 || mains.length > 8) return;
    let entries;
    try {
      entries = (0, import_node_fs5.readdirSync)(abs, { withFileTypes: true });
    } catch {
      return;
    }
    let isMain = false;
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".go") && !e.name.endsWith("_test.go")) {
        const src = readText(abs, e.name) ?? "";
        if (/^\s*package\s+main\s*$/m.test(src)) isMain = true;
      }
    }
    if (isMain) mains.push(rel);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "vendor" || e.name === "node_modules") continue;
      walk((0, import_node_path5.join)(abs, e.name), rel === "." ? `./${e.name}` : `${rel}/${e.name}`, depth + 1);
    }
  };
  walk(dir, ".", 0);
  if (mains.length === 1) return { pattern: mains[0], sure: true };
  if (mains.includes(".")) return { pattern: ".", sure: true };
  const underCmd = mains.filter((m) => m.startsWith("./cmd/"));
  if (underCmd.length === 1) return { pattern: underCmd[0], sure: true };
  const named = GO_SERVER_DIRS.map((n) => underCmd.find((m) => m === `./cmd/${n}`)).filter(Boolean);
  if (named.length === 1) return { pattern: named[0], sure: true };
  return { pattern: null, sure: false };
}
function buildFor(language, manager, f) {
  if (language === "node") {
    const scripts = f.pkg?.scripts ?? {};
    return { build: scripts.build ? `${manager === "bun" ? "bun" : manager} run build` : void 0, sure: true };
  }
  if (language === "go") {
    const main = goMainPackage(f.dir);
    return main.pattern ? { build: `go build -o /app/server ${main.pattern}`, sure: main.sure } : { sure: false };
  }
  if (language === "rust") return { build: "cargo build --release", sure: true };
  if (language === "java") {
    return manager === "maven" ? { build: "mvn -B -DskipTests package", sure: true } : { build: `${hasFile(f.dir, "gradlew") ? "./gradlew" : "gradle"} --no-daemon build -x test`, sure: true };
  }
  if (language === "ruby" && f.gemfile && /rails/i.test(f.gemfile)) {
    return { build: "bundle exec rails assets:precompile", sure: true };
  }
  return { sure: true };
}
function staticOutputDir(f) {
  if (f.deps.has("next")) return nextIsExport(f.nextConfig) ? "out" : void 0;
  if (f.deps.has("astro") || f.astroConfig) return astroHasAdapter(f.astroConfig) ? void 0 : "dist";
  if (f.deps.has("@sveltejs/kit") || f.svelteConfig) return svelteHasNodeAdapter(f) ? void 0 : "build";
  if (f.deps.has("react-scripts")) return "build";
  if (f.deps.has("vite")) return "dist";
  if (hasFile(f.dir, "index.html")) return ".";
  return void 0;
}
function languagesIn(dir) {
  return RUNTIME_LANGUAGES.filter((l) => PACKAGE_RULES[l].some((r) => hasFile(dir, r.file)));
}
function toolchainFor(language, f, rel, repoRoot) {
  let rule = PACKAGE_RULES[language].find((r) => hasFile(f.dir, r.file));
  const rootInstall = language === "node" && rel !== "." && workspaceRootOf(repoRoot) ? PACKAGE_RULES.node.find((r) => r.install || r.installFor ? hasFile(repoRoot, r.file) : false) : void 0;
  const hoisted = rootInstall && rootInstall.file !== "package.json" ? rootInstall : void 0;
  if (hoisted) rule = hoisted;
  if (!rule) return null;
  const installFrom = hoisted ? repoRoot : f.dir;
  const { build, sure } = buildFor(language, rule.manager, f);
  const own = pinFor(runtimePins(readRuntimeFiles(f.dir)), language);
  const inherited = !own && repoRoot !== f.dir ? pinFor(runtimePins(readRuntimeFiles(repoRoot)), language) : null;
  const runtime = resolveRuntime(
    language,
    own ?? (inherited ? { ...inherited, from: `${inherited.from} (repo root)` } : null)
  );
  return {
    tc: {
      language,
      version: runtime.version,
      versionFrom: runtime.versionFrom,
      packageManager: rule.manager,
      install: rule.installFor ? rule.installFor(installFrom) : rule.install,
      installProject: rule.installProject,
      build,
      dir: rel,
      // The root, when the root is where the dependencies live.
      installDir: hoisted ? "." : void 0
    },
    sure
  };
}
function workspaceRootOf(dir) {
  const pkg = readJson(dir, "package.json");
  const w = (pkg ?? {}).workspaces;
  return Array.isArray(w) ? w.length > 0 : Boolean(w && typeof w === "object");
}
function detect(dir, options = {}, rel = ".") {
  const { run, config } = options;
  const f = dirFacts(dir, rel);
  const repoRoot = options.repoRoot ?? (rel === "." ? dir : (0, import_node_path5.resolve)(dir, ...rel.split("/").filter((s) => s && s !== ".").map(() => "..")));
  const present = languagesIn(dir);
  const built = present.map((l) => toolchainFor(l, f, rel, repoRoot)).filter((t) => t !== null);
  let command;
  let framework;
  let extra;
  let confidence = "certain";
  let procfile = null;
  try {
    procfile = readProcfile(dir);
  } catch {
    procfile = null;
  }
  const configWeb = config?.processes?.web?.command ?? config?.start;
  const procfileWeb = procfile?.find((e) => e.name === "web")?.command;
  const pkgScripts = f.pkg?.scripts ?? {};
  const nodeManager = built.find((b) => b.tc.language === "node")?.tc.packageManager ?? "npm";
  const staticDir = staticOutputDir(f);
  const scriptStart = pkgScripts.start && !staticDir ? `${nodeManager} start` : void 0;
  const declared = run?.trim() || configWeb?.trim() || procfileWeb?.trim() || scriptStart;
  if (declared) {
    command = declared;
    framework = FRAMEWORK_START.find((r) => r.when(f))?.token;
  } else {
    const row = FRAMEWORK_START.find((r) => r.when(f));
    const started = row?.start(f) ?? null;
    if (row && started) {
      command = started;
      framework = row.token;
      extra = row.extra;
      confidence = "inferred";
    } else {
      framework = row?.token;
    }
  }
  if (command) command = bindToPort(command);
  const outputDir = command ? void 0 : staticDir;
  if (!command && !outputDir) confidence = "guessed";
  if (extra) {
    const python = built.find((b) => b.tc.language === "python");
    if (python && !new RegExp(`(^|[^\\w-])${extra}`, "i").test(f.pythonText)) {
      const into = python.tc.packageManager === "uv" ? `uv pip install ${extra}` : `pip install --no-cache-dir ${extra}`;
      const target = python.tc.installProject ? "installProject" : "install";
      python.tc[target] = python.tc[target] ? `${python.tc[target]} && ${into}` : into;
    }
  }
  const needs = [...new Set(NEEDS.filter((n) => n.when(f)).flatMap((n) => n.packages))];
  if (built.some((b) => !b.sure) && confidence === "certain") confidence = "inferred";
  const toolchains = orderToolchains(built.map((b) => b.tc), framework, command);
  return {
    toolchains,
    language: toolchains[0]?.language ?? "static",
    framework,
    command,
    release: detectRelease(f, procfile, config),
    outputDir,
    database: detectDatabase(f),
    needs,
    confidence
  };
}
function orderToolchains(toolchains, framework, command) {
  if (toolchains.length < 2) return toolchains;
  const cmd = command ?? "";
  const serves = (t) => {
    if (t.language === "python") return /\b(gunicorn|uvicorn|hypercorn|daphne|granian|waitress|python3?)\b/.test(cmd);
    if (t.language === "node") return /\b(node|npm|pnpm|yarn|bun|next|nuxt|react-router-serve)\b/.test(cmd);
    if (t.language === "ruby") return /\b(bundle|ruby|rackup|rails)\b/.test(cmd);
    if (t.language === "php") return /\bphp\b/.test(cmd);
    if (t.language === "go") return /\/app\/server\b/.test(cmd);
    if (t.language === "rust") return /\/app\/target\/release\//.test(cmd);
    if (t.language === "java") return /\bjava\b/.test(cmd);
    return false;
  };
  const first = toolchains.findIndex(serves);
  if (first > 0) return [toolchains[first], ...toolchains.filter((_, i) => i !== first)];
  if (first === -1 && framework) {
    const byFramework = toolchains.findIndex((t) => t.language === (["django", "fastapi", "flask"].includes(framework) ? "python" : ["rails"].includes(framework) ? "ruby" : ["laravel"].includes(framework) ? "php" : "node"));
    if (byFramework > 0) return [toolchains[byFramework], ...toolchains.filter((_, i) => i !== byFramework)];
  }
  return toolchains;
}

// lib/dockerfile-context.ts
function copySources(dockerfile) {
  const out = [];
  const lines = dockerfile.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    let last = i;
    while (/\\\s*$/.test(raw) && last + 1 < lines.length) {
      last++;
      raw = raw.replace(/\\\s*$/, " ") + lines[last];
    }
    const started = i;
    i = last;
    const m = /^\s*(COPY|ADD)\s+(.*)$/i.exec(raw);
    if (!m) continue;
    let rest = m[2].trim();
    if (rest.startsWith("#")) continue;
    let fromStage = false;
    while (rest.startsWith("--")) {
      const flag = rest.slice(0, rest.search(/\s/) < 0 ? rest.length : rest.search(/\s/));
      if (/^--from=/i.test(flag)) fromStage = true;
      rest = rest.slice(flag.length).trim();
    }
    if (fromStage || !rest) continue;
    let args;
    if (rest.startsWith("[")) {
      try {
        const parsed = JSON.parse(rest);
        args = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        continue;
      }
    } else {
      args = rest.split(/\s+/).filter(Boolean).map((a) => a.replace(/^["']|["']$/g, ""));
    }
    if (args.length < 2) continue;
    for (const src of args.slice(0, -1)) {
      if (src.includes("$")) continue;
      out.push({ path: src, line: started + 1 });
    }
  }
  return out;
}
function buildOwner(candidates) {
  const dirs = candidates.map((c) => c.dir.replace(/^\.\//, "").replace(/\/+$/, "")).filter((d) => d && d !== ".");
  for (const c of candidates) {
    if (!c.dockerfile) continue;
    const mine = c.dir.replace(/^\.\//, "").replace(/\/+$/, "");
    for (const { path } of copySources(c.dockerfile)) {
      const head = path.replace(/^\.\//, "").split("/")[0];
      if (head && head !== mine && dirs.includes(head)) return c.dir;
    }
  }
  return null;
}

// lib/infer-services.ts
var BROWSER_FACING = /next|nuxt|remix|svelte|astro|vite|create react app|static/i;
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
function dirOf(manifestPath) {
  const i = manifestPath.lastIndexOf("/");
  return i === -1 ? "." : manifestPath.slice(0, i);
}
function isWorkspaceRoot(repoDir) {
  const p = (0, import_node_path6.join)(repoDir, "package.json");
  if (!(0, import_node_fs6.existsSync)(p)) return false;
  try {
    return Boolean(JSON.parse((0, import_node_fs6.readFileSync)(p, "utf8")).workspaces);
  } catch {
    return false;
  }
}
function isDeployablePart(absoluteDir, relDir) {
  if (relDir.split("/").some((seg) => NOT_AN_APP.has(seg.toLowerCase()))) return false;
  const pkgPath = (0, import_node_path6.join)(absoluteDir, "package.json");
  if ((0, import_node_fs6.existsSync)(pkgPath)) {
    try {
      const pkg = JSON.parse((0, import_node_fs6.readFileSync)(pkgPath, "utf8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.build || scripts.start) return true;
      const deps = Object.keys({ ...pkg.dependencies ?? {}, ...pkg.devDependencies ?? {} });
      return deps.some((d) => NODE_FRAMEWORK.test(d));
    } catch {
      return false;
    }
  }
  return PYTHON_RUNNABLE.some((entry) => (0, import_node_fs6.existsSync)((0, import_node_path6.join)(absoluteDir, entry)));
}
function startFor(stack, absoluteDir) {
  const bound = bindToPort(stack.startCommand);
  if (!/^python/i.test(stack.language)) return bound;
  const mod = pythonModule(absoluteDir);
  if (!mod) return bound;
  return bound.replace(/[\w.]+(?=:app\b)/, mod);
}
function languageOf(stack) {
  return serviceLanguage(stack.language, stack.serve.mode === "static");
}
function serviceFor(relDir, stack, absoluteDir) {
  const language = languageOf(stack);
  const name = relDir === "." ? "app" : import_node_path6.posix.basename(relDir);
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
  return { ...base, start: startFor(stack, absoluteDir), release: stack.release };
}
function deployableParts(repoDir, facts) {
  const dirs = [];
  for (const d of facts.declarations) {
    const dir = dirOf(d.from);
    if (dirs.includes(dir)) continue;
    if (!isDeployablePart(dir === "." ? repoDir : (0, import_node_path6.join)(repoDir, dir), dir)) continue;
    dirs.push(dir);
  }
  const nested = dirs.filter((d) => d !== ".");
  return nested.length >= 2 || dirs.includes(".") && isWorkspaceRoot(repoDir) ? nested : dirs;
}
async function inferAppConfig(repoDir, detect2) {
  const facts = readRepoFacts(repoDir);
  if (!facts.declarations.length) return null;
  if (facts.dockerfiles.includes("Dockerfile")) return null;
  const parts2 = deployableParts(repoDir, facts);
  if (parts2.length === 1 && parts2[0] !== "." && isWorkspaceRoot(repoDir)) {
    try {
      const abs = (0, import_node_path6.join)(repoDir, parts2[0]);
      return { version: 1, services: [{ ...serviceFor(parts2[0], await detect2(abs), abs), path: "/" }] };
    } catch {
      return null;
    }
  }
  if (parts2.length < 2) return null;
  const owner = buildOwner(parts2.map((rel) => {
    const at = rel === "." ? repoDir : (0, import_node_path6.join)(repoDir, rel);
    const file = (0, import_node_path6.join)(at, "Dockerfile");
    return { dir: rel, dockerfile: (0, import_node_fs6.existsSync)(file) ? (0, import_node_fs6.readFileSync)(file, "utf8") : void 0 };
  }));
  if (owner) {
    try {
      const abs = owner === "." ? repoDir : (0, import_node_path6.join)(repoDir, owner);
      return { version: 1, services: [{ ...serviceFor(owner, await detect2(abs), abs), path: "/" }] };
    } catch {
      return null;
    }
  }
  let detected;
  try {
    detected = await Promise.all(parts2.map(async (rel) => {
      const abs = rel === "." ? repoDir : (0, import_node_path6.join)(repoDir, rel);
      return { rel, abs, stack: await detect2(abs) };
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
function laneFor(i) {
  if (i.language === "static") return "static";
  return "container";
}
function deriveLane(s) {
  return laneFor({ language: s.language, runtime: s.runtime, dockerfile: s.dockerfile });
}
var LANE_CONSUMES = {
  static: ["install", "build", "outputDir", "spaFallback", "buildEnv", "env"],
  // No `start`: when the author committed the Dockerfile, its own CMD is the
  // start command and a second one in the config would be read by nobody. That
  // is still true, and it is the reason this list is not simply the union of the
  // two lanes it replaces.
  container: ["dockerfile", "context", "release", "processes", "env", "buildEnv", "secrets", "uses", "health", "scale", "framework"]
};
var GENERATED_DOCKERFILE_CONSUMES = [
  "install",
  "build",
  "start",
  "runtime"
];
var UNIVERSAL = ["name", "dir", "path", "lane", "envNeeded", "declared"];
function assertConsumed(s) {
  const allowed = /* @__PURE__ */ new Set([
    ...LANE_CONSUMES[s.lane],
    ...UNIVERSAL,
    // An app whose Dockerfile the platform writes reads four more fields, because
    // they are what it is written FROM. See GENERATED_DOCKERFILE_CONSUMES.
    ...s.lane === "container" && !s.dockerfile ? GENERATED_DOCKERFILE_CONSUMES : []
  ]);
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
function resolveService(s, index, runtimePinned = false) {
  const dir = s.dir ?? ".";
  const lane = laneFor({
    language: s.language,
    runtime: s.runtime,
    dockerfile: s.dockerfile,
    runtimePinned
  });
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
async function resolve2(dir, detect2) {
  let config = null;
  let source = "config";
  config = readAppConfig(dir);
  if (!config) {
    if (!detect2) throw new ResolveError(`${dir} has no ${CONFIG_FILENAME} and no detector was supplied \u2014 run \`supersonic init\``);
    config = await inferAppConfig(dir, detect2);
    source = "inferred";
  }
  if (!config) {
    throw new ResolveError(
      `could not work out how to deploy ${dir}.
  Run \`supersonic init\` to write a ${CONFIG_FILENAME} draft, then check it.`
    );
  }
  return resolveFrom(config, source, repoPinsRuntime(dir));
}
function repoPinsRuntime(dir) {
  const read = (f) => {
    try {
      return (0, import_node_fs7.existsSync)((0, import_node_path7.join)(dir, f)) ? (0, import_node_fs7.readFileSync)((0, import_node_path7.join)(dir, f), "utf8") : null;
    } catch {
      return null;
    }
  };
  const pin = repoRuntime({
    pythonVersion: read(".python-version"),
    runtimeTxt: read("runtime.txt"),
    pyproject: read("pyproject.toml"),
    nvmrc: read(".nvmrc"),
    packageJson: (() => {
      try {
        return JSON.parse(read("package.json") ?? "null");
      } catch {
        return null;
      }
    })()
  });
  return Boolean(pin && !runnerServes(pin));
}
function resolveFrom(config, source, runtimePinned = false) {
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
    services: ordered.map((svc, i) => resolveService(svc, i, runtimePinned))
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
    const abs = (0, import_node_path7.join)(dir, s.dir);
    if (!(0, import_node_fs7.existsSync)(abs)) {
      problems.push(`${where}: directory "${s.dir}" does not exist`);
      continue;
    }
    if (s.lane === "static") {
      if (s.build && !s.declared.includes("outputDir")) {
        problems.push(`${where}: has a build command but no outputDir \u2014 what should be published?`);
      }
      if (!s.build && s.outputDir && !(0, import_node_fs7.existsSync)((0, import_node_path7.join)(dir, s.outputDir))) {
        problems.push(`${where}: outputDir "${s.outputDir}" does not exist and no build command would create it`);
      }
    } else if (!s.dockerfile && !s.start && !s.processes.length) {
      problems.push(
        `${where}: this service has no \`start\` command and no Dockerfile of its own
  If this app is a worker, a bot or a scheduled job, declare "processes" instead.`
      );
    }
    if (s.dockerfile) {
      if (!(0, import_node_fs7.existsSync)((0, import_node_path7.join)(dir, s.dockerfile))) {
        problems.push(`${where}: dockerfile "${s.dockerfile}" does not exist`);
      }
      if (s.context && !(0, import_node_fs7.existsSync)((0, import_node_path7.join)(dir, s.context))) {
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
var DEFAULT_TASK_TIMEOUT = 1800;
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
  detect,
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
  serviceLanguage,
  servicePath,
  unemittable,
  validate
});
