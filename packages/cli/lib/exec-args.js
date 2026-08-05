"use strict";

/**
 * Turn the words after `--` into one command for a remote `sh`.
 *
 * Two shapes reach this, and joining them the same way breaks one of them:
 *
 *   supersonic exec app -- "ls | wc -l"           one argument, already a shell
 *                                                 snippet — the pipe is meant
 *   supersonic exec app -- python -c 'print(1)'   argv, and the local shell has
 *                                                 already removed the quotes
 *
 * A plain `.join(" ")` served the first and silently corrupted the second. The
 * server base64s whatever it is given and pipes it to `sh`, so `print(1)`
 * arrives bare and sh answers `Syntax error: "(" unexpected`. Anything with a
 * parenthesis, a quote, a `$`, a `;` or a space inside one argv word was
 * affected, which is most non-trivial one-liners.
 *
 * One argument stays raw, because the user wrote shell and means it. Several
 * arguments are quoted individually, because the shell already split them and
 * the quotes it removed have to be put back. `docker exec` and `kubectl exec`
 * draw the line in the same place.
 */
function joinExecArgs(words) {
  const w = Array.isArray(words) ? words : [];
  if (w.length <= 1) return String(w[0] ?? "").trim();
  return w.map(shellQuote).join(" ").trim();
}

/**
 * POSIX single-quoting. Everything is literal inside '…', and a single quote is
 * itself escaped by closing the string, adding \' , and reopening.
 */
function shellQuote(word) {
  const s = String(word);
  if (s !== "" && /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

module.exports = { joinExecArgs, shellQuote };
