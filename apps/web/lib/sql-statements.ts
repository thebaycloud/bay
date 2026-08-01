/**
 * Splitting a migration file into statements, for the ones that cannot be sent
 * as a batch.
 *
 * `db/migrate.ts` sends each file to `pool.query()` in one call. That uses the
 * simple query protocol, and Postgres runs a multi-statement simple query inside
 * one implicit transaction block — which is exactly what `000_base.sql` relies
 * on when it says a failure rolls the whole file back.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Not in a
 * file beside other statements, and not in a file of its own holding two of
 * them: two statements in one call is still a block. The only way to run one
 * through this runner is to send it as the only statement in its call, which is
 * what this file exists to make possible.
 *
 * Splitting SQL on semicolons is a classic way to break a migration, so this
 * does it properly: string literals, quoted identifiers, dollar-quoted bodies
 * and both comment forms are all skipped over. There is a test that splitting
 * `002_allowlist.sql` keeps its `DO $$ … END $$` block in one piece.
 */

/**
 * Marks a file that must be applied one statement at a time, outside any
 * transaction. Opt-in: every existing migration keeps its all-or-nothing
 * behaviour, which is the safer default and the one they were written against.
 */
export const NO_TRANSACTION_DIRECTIVE = "-- migrate: no-transaction";

export function isNoTransaction(sql: string): boolean {
  // Anywhere in the leading comment block, so the directive can sit under a
  // heading rather than having to be the first byte of the file.
  return sql.split(/\r?\n/).some((line) => line.trim().toLowerCase() === NO_TRANSACTION_DIRECTIVE);
}

/**
 * Split SQL into executable statements, dropping empty ones.
 *
 * Comments are preserved inside the statement they precede; a trailing comment
 * with no statement after it produces nothing.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;

  const push = (end: number) => {
    const chunk = sql.slice(start, end);
    // A chunk that is only comments and whitespace is not a statement. Detected
    // by stripping comments rather than by regex over the raw text, so a `--`
    // inside a string literal cannot make a real statement look empty.
    if (stripComments(chunk).trim()) out.push(chunk.trim());
    start = end + 1;
  };

  while (i < sql.length) {
    const c = sql[i];

    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // A doubled quote is an escaped one, not the end.
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const tag = dollarTagAt(sql, i);
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        continue;
      }
    }
    if (c === ";") {
      push(i);
      i++;
      continue;
    }
    i++;
  }

  push(sql.length);
  return out;
}

/** `$$` or `$tag$` starting at `i`, or null if this `$` opens nothing. */
function dollarTagAt(sql: string, i: number): string | null {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
  return m ? m[0] : null;
}

/** Comments removed, for emptiness checks only — never for execution. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}
