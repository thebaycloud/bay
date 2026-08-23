"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const brand = require("../lib/brand");

/**
 * The rename, on somebody else's machine.
 *
 * A published CLI is not a service. It is a copy sitting in a global npm
 * directory until its owner upgrades, which may be never — so every lookup that
 * used to find `supersonic` has to keep finding it. Each test below is one way
 * a plain rename would have signed somebody out, redirected their CI, or made
 * the CLI forget which app a folder is.
 */

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "brand-"));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test("an environment variable is read under either name, new one winning", () => {
  assert.equal(brand.envAny("URL", { BAY_URL: "https://new" }), "https://new");
  assert.equal(brand.envAny("URL", { SUPERSONIC_URL: "https://old" }), "https://old");
  assert.equal(
    brand.envAny("URL", { BAY_URL: "https://new", SUPERSONIC_URL: "https://old" }),
    "https://new",
    "the new name has to win, or upgrading changes nothing",
  );
  assert.equal(brand.envAny("URL", {}), undefined);
});

test("an empty value is not a value, under either name", () => {
  // `BAY_URL=` in a shell profile is how somebody unsets a variable they no
  // longer want. Treating it as set would beat a SUPERSONIC_URL that is real.
  assert.equal(brand.envAny("URL", { BAY_URL: "", SUPERSONIC_URL: "https://old" }), "https://old");
  assert.equal(brand.envAny("URL", { BAY_URL: "   ", SUPERSONIC_URL: "https://old" }), "https://old");
});

test("a project file is found under either name, and created under the new one", () => {
  const { home, cleanup } = sandbox();
  try {
    // Nothing there: the path offered is the new name, so a first write creates it.
    assert.equal(brand.projectFile(home, "json"), path.join(home, "bay.json"));

    // Only the old name: it is found, or the CLI forgets which app this folder
    // is and reserves a second slug for it.
    fs.writeFileSync(path.join(home, "supersonic.json"), "{}");
    assert.equal(brand.projectFile(home, "json"), path.join(home, "supersonic.json"));

    // Both: the new one wins.
    fs.writeFileSync(path.join(home, "bay.json"), "{}");
    assert.equal(brand.projectFile(home, "json"), path.join(home, "bay.json"));
  } finally { cleanup(); }
});

test("the config directory follows what is actually on disk", () => {
  const { home, cleanup } = sandbox();
  const realHome = os.homedir;
  try {
    os.homedir = () => home;
    delete require.cache[require.resolve("../lib/brand")];
    const b = require("../lib/brand");

    // Fresh machine: the new name, and the old one is never mentioned.
    assert.equal(b.configDir(), path.join(home, ".bay"));

    // An existing install: found where it actually is, or its token is invisible
    // and the person is signed out by an upgrade.
    fs.mkdirSync(path.join(home, ".supersonic"), { recursive: true });
    assert.equal(b.configDir(), path.join(home, ".supersonic"));

    // Both present: the new one.
    fs.mkdirSync(path.join(home, ".bay"), { recursive: true });
    assert.equal(b.configDir(), path.join(home, ".bay"));
  } finally {
    os.homedir = realHome;
    delete require.cache[require.resolve("../lib/brand")];
    cleanup();
  }
});

test("migrating copies the token across and leaves the original alone", () => {
  const { home, cleanup } = sandbox();
  const realHome = os.homedir;
  try {
    os.homedir = () => home;
    delete require.cache[require.resolve("../lib/brand")];
    const b = require("../lib/brand");

    fs.mkdirSync(path.join(home, ".supersonic"), { recursive: true });
    fs.writeFileSync(path.join(home, ".supersonic", "config.json"), '{"token":"t"}');

    b.migrateConfig();

    assert.equal(fs.readFileSync(path.join(home, ".bay", "config.json"), "utf8"), '{"token":"t"}');
    // COPY, not move. An older CLI on the same machine still reads the old path,
    // and taking the file out from under it would sign that copy out to fix this.
    assert.ok(fs.existsSync(path.join(home, ".supersonic", "config.json")));
  } finally {
    os.homedir = realHome;
    delete require.cache[require.resolve("../lib/brand")];
    cleanup();
  }
});

test("migrating never overwrites a config that is already there", () => {
  const { home, cleanup } = sandbox();
  const realHome = os.homedir;
  try {
    os.homedir = () => home;
    delete require.cache[require.resolve("../lib/brand")];
    const b = require("../lib/brand");

    fs.mkdirSync(path.join(home, ".supersonic"), { recursive: true });
    fs.writeFileSync(path.join(home, ".supersonic", "config.json"), '{"token":"old"}');
    fs.mkdirSync(path.join(home, ".bay"), { recursive: true });
    fs.writeFileSync(path.join(home, ".bay", "config.json"), '{"token":"current"}');

    b.migrateConfig();

    assert.equal(
      fs.readFileSync(path.join(home, ".bay", "config.json"), "utf8"),
      '{"token":"current"}',
      "a stale token from the old path must not replace the one in use",
    );
  } finally {
    os.homedir = realHome;
    delete require.cache[require.resolve("../lib/brand")];
    cleanup();
  }
});

test("migrating is silent when there is nothing to migrate", () => {
  const { home, cleanup } = sandbox();
  const realHome = os.homedir;
  try {
    os.homedir = () => home;
    delete require.cache[require.resolve("../lib/brand")];
    const b = require("../lib/brand");
    b.migrateConfig();
    assert.equal(fs.existsSync(path.join(home, ".bay")), false);
  } finally {
    os.homedir = realHome;
    delete require.cache[require.resolve("../lib/brand")];
    cleanup();
  }
});
