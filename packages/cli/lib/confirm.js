"use strict";

/**
 * Whether a destructive command may proceed, and what to say when it may not.
 *
 * This CLI is "designed for agents, not humans: no interactive prompts" — the
 * first paragraph of index.js says so — which removes the usual answer to "are
 * you sure". A prompt cannot be the safety, so an explicit flag is: the caller
 * has to name the app AND say `--yes`, and the refusal tells them the exact line
 * to run.
 *
 * That is also the right shape for the agent this is built for. A prompt is
 * something an agent works around; a flag is something it has to mean.
 */

/**
 * @param {string} app  the app named on the command line
 * @param {{yes?: unknown}} args
 * @returns {string|null} the refusal to print, or null if it may proceed
 */
function deletionRefusal(app, args) {
  // `--yes` alone parses to `true`; `--yes <app>` parses to the string, because
  // the parser takes the next token as a value when it is not another flag.
  // Both are accepted — a caller who wrote the app name twice meant it at least
  // as much as one who wrote it once.
  const said = args.yes;
  if (said === true || (typeof said === "string" && said === app)) return null;

  // A DIFFERENT app name is refused rather than ignored, and this is the case
  // worth having a branch for: `bay delete api --yes web` is somebody
  // editing a previous command and changing one of the two names. Proceeding
  // would delete `api` on the strength of a confirmation that says `web`.
  if (typeof said === "string" && said !== app) {
    return `refusing: you named ${app} but confirmed ${said}. If you mean ${app}, run\n  bay delete ${app} --yes`;
  }

  return [
    `${app} would be deleted, and so would its DATA: the database, the storage`,
    "bucket, the images and the deploy history all go with it.",
    "",
    "This cannot be undone, and there is no prompt to say yes to — run",
    `  bay delete ${app} --yes`,
  ].join("\n");
}

module.exports = { deletionRefusal };
