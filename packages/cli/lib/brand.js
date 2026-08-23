"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");

/**
 * What this CLI is called, where it keeps things, and what it reads from the
 * environment.
 *
 * ## Why every lookup here has two answers
 *
 * This is the one part of the rename that runs on other people's machines. A
 * published CLI is not a service: it is a copy of the code sitting in somebody's
 * global npm directory, and it stays there until they upgrade — which may be
 * never. So nothing here may simply be renamed.
 *
 * Three things would break silently if it were:
 *
 * - `~/.supersonic/config.json` holds the sign-in token. Reading only `~/.bay`
 *   would sign everybody out and look, from the outside, exactly like a session
 *   that expired.
 * - `SUPERSONIC_URL` and `SUPERSONIC_TOKEN` are in people's CI configuration and
 *   in agent scripts. Reading only the new names turns a working pipeline into
 *   one that deploys to production instead of staging, or to nowhere.
 * - `supersonic.json` sits in repositories. Reading only `bay.json` makes the
 *   CLI forget which app a folder belongs to and reserve a second slug.
 *
 * So: the new name is written, and either name is read. The old name goes away
 * when the logs show nobody is using it, and not before.
 */

const BRAND = "Bay";
const CLI = "bay";
const DOMAIN = "thebay.cloud";
const DEFAULT_URL = "https://app.supersonic.cv";

const NEW_DIR = path.join(os.homedir(), ".bay");
const OLD_DIR = path.join(os.homedir(), ".supersonic");

/**
 * Where config lives.
 *
 * The new directory once it exists; the old one while it is the only one there.
 * A brand-new install gets the new path and never sees the old name.
 */
function configDir() {
  try {
    if (fs.existsSync(NEW_DIR)) return NEW_DIR;
    if (fs.existsSync(OLD_DIR)) return OLD_DIR;
  } catch { /* unreadable home — fall through */ }
  return NEW_DIR;
}

/**
 * Move an existing config across, once.
 *
 * Copy rather than move, and only when the new location is empty: an older CLI
 * on the same machine still reads the old path, and taking the file out from
 * under it would sign that copy out to fix this one.
 *
 * Best-effort in every direction. A migration that throws would break `deploy`
 * for a reason that has nothing to do with deploying.
 */
function migrateConfig() {
  try {
    if (fs.existsSync(NEW_DIR)) return;
    if (!fs.existsSync(path.join(OLD_DIR, "config.json"))) return;
    fs.mkdirSync(NEW_DIR, { recursive: true });
    fs.copyFileSync(path.join(OLD_DIR, "config.json"), path.join(NEW_DIR, "config.json"));
  } catch { /* best effort */ }
}

/**
 * An environment variable under either name, new first.
 *
 * `envAny("URL")` reads BAY_URL, then SUPERSONIC_URL.
 */
function envAny(suffix, env) {
  const e = env || process.env;
  const fresh = e[`BAY_${suffix}`];
  if (fresh !== undefined && String(fresh).trim() !== "") return fresh;
  const legacy = e[`SUPERSONIC_${suffix}`];
  if (legacy !== undefined && String(legacy).trim() !== "") return legacy;
  return undefined;
}

/**
 * A per-project file under either name, new first.
 *
 * Returns the path that exists, or the new-name path when neither does — so a
 * first write always creates the new name.
 */
function projectFile(dir, base) {
  const fresh = path.join(dir, `bay.${base}`);
  const legacy = path.join(dir, `supersonic.${base}`);
  try {
    if (fs.existsSync(fresh)) return fresh;
    if (fs.existsSync(legacy)) return legacy;
  } catch { /* fall through */ }
  return fresh;
}

/**
 * A protocol header under both names.
 *
 * Sending both, rather than switching, makes this CLI independent of which
 * server it happens to be talking to. A control plane that only knows
 * `x-supersonic-*` still understands it; one that prefers `x-bay-*` gets that.
 * The alternative — switch the CLI and require the server to be deployed first
 * — turns every publish into an ordering problem, and gets it wrong once.
 *
 * Costs a few dozen bytes per request. The old half comes out when the server
 * has stopped reading it.
 */
function protoHeaders(name, value) {
  return { [`x-bay-${name}`]: value, [`x-supersonic-${name}`]: value };
}

module.exports = {
  BRAND, CLI, DOMAIN, DEFAULT_URL,
  NEW_DIR, OLD_DIR,
  configDir, migrateConfig, envAny, projectFile, protoHeaders,
};
