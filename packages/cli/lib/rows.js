"use strict";

/**
 * Query results as a table a terminal can hold.
 *
 * `bay db <app> <table>` returns real production rows, and a row is not a
 * shape this CLI controls: one column is an id, the next is a 4KB blob of JSON,
 * and printing them raw turns a 12-row answer into four screens of wrapped text
 * with no visible columns at all. So every cell is flattened to one line and
 * clipped, and the width is the widest cell that survived.
 *
 * Clipping is marked with `…` rather than being silent. A truncated value that
 * looks whole is worse than no value: it is the one a person copies.
 *
 * `--json` exists for everything this drops. That is the contract — this is the
 * human reading, `--json` is the data.
 */

/** null and undefined are not the string "null" — they are the empty cell. */
function cell(v, max) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Tabs and newlines inside a value would break the alignment of every row
  // after them, so they become a single space before anything is measured.
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * @param {string[]} columns
 * @param {object[]} rows
 * @param {{max?: number}} [opts]  max characters per cell (default 40)
 * @returns {string[]} lines: a header, a rule, then one line per row
 */
function renderTable(columns, rows, opts = {}) {
  const max = opts.max ?? 40;
  const cols = columns || [];
  if (!cols.length) return [];

  const body = (rows || []).map((r) =>
    // Arrays as well as objects: `SELECT` results arrive keyed by column name,
    // but a caller holding tuples should not have to convert them first.
    cols.map((c, i) => cell(Array.isArray(r) ? r[i] : r?.[c], max))
  );

  const width = cols.map((c, i) =>
    Math.max(cell(c, max).length, ...body.map((r) => r[i].length), 1)
  );

  // The last column is not padded. Trailing spaces are invisible until somebody
  // pipes this into a diff, and every line would carry them.
  const line = (parts) => parts.map((p, i) => (i === parts.length - 1 ? p : p.padEnd(width[i]))).join("  ").trimEnd();

  return [
    line(cols.map((c) => cell(c, max))),
    line(width.map((w) => "─".repeat(w))),
    ...body.map(line),
  ];
}

module.exports = { renderTable, cell };
