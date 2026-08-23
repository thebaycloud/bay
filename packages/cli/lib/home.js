"use strict";

/**
 * Where the session lives, and what the variables are called, across a rename.
 *
 * Both answers changed at once — `~/.supersonic` became `~/.bay`, `SUPERSONIC_*`
 * became `BAY_*` — and both have the same failure mode if they change carelessly:
 * the CLI comes up signed out. Not broken, not erroring; signed out, with a
 * perfectly good token sitting in a file it stopped looking at, and an agent
 * mid-task being told to open a browser.
 *
 * Pure, and taking the home directory and an existence check as arguments, so
 * the migration can be tested without touching anyone's real home.
 */

/**
 * The config directory: the new name if it is there, the old name if IT is, the
 * new name otherwise.
 *
 * Deliberately not "read both and merge". Two files that disagree about which
 * account you are would be resolved by whichever line ran first, and the symptom
 * — deploying to the wrong account — is one nobody would trace back to here. One
 * directory wins outright, and an existing user keeps writing to the file they
 * already have.
 */
function configDirIn(home, exists, join) {
  const next = join(home, ".bay");
  const prev = join(home, ".supersonic");
  if (exists(next)) return next;
  if (exists(prev)) return prev;
  return next;
}

/**
 * `BAY_<NAME>`, falling back to `SUPERSONIC_<NAME>`.
 *
 * The new name wins when both are set: somebody who exported both is midway
 * through a migration, and the value they added last is the one they mean. An
 * empty string is treated as unset, which is what a shell gives you for an
 * exported-but-never-assigned variable.
 */
function envVarFrom(env, name) {
  return (env["BAY_" + name] || env["SUPERSONIC_" + name] || "").trim();
}

module.exports = { configDirIn, envVarFrom };
