import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recencyColumn, orderingFor, describeOrdering, pageQuery,
  pageSize, pageOffset, MAX_PAGE, DEFAULT_PAGE,
  countQuery, describeSort, parseFilter, parseSort, opTakesValue, FILTER_OPS,
  checkKey, editRefusal, updateRowQuery,
  type TableShape,
} from "../lib/db-browse";

const table = (columns: Array<[string, string]>, primaryKey: string[] = [], name = "orders"): TableShape =>
  ({ name, primaryKey, columns: columns.map(([n, t]) => ({ name: n, type: t })) });

/* ── which column says when a row arrived ─────────────────────────────────── */

test("a table with no clock gets no freshness, rather than an invented one", () => {
  // The whole reason this returns null instead of guessing. A cell that says
  // nothing about time is true; one that reports a number it derived from
  // nothing is the same defect as the row count that read zero for a table with
  // rows in it.
  assert.equal(recencyColumn(table([["id", "integer"], ["email", "text"]])), null);
});

test("arrival is preferred over change, and `updated_at` is never arrival", () => {
  // A table whose rows are edited would otherwise report a freshness that has
  // nothing to do with anything landing — which is the question being asked.
  assert.equal(recencyColumn(table([["updated_at", "timestamp with time zone"]])), null);
  assert.equal(
    recencyColumn(table([["updated_at", "timestamp with time zone"], ["created_at", "timestamp with time zone"]])),
    "created_at",
  );
});

test("one clock is THE clock, whatever it is called", () => {
  // The rule this started without, and the evidence that produced it: the
  // platform's own `pgapp` example — deployed to production to check exactly
  // this — has a `timestamptz` column called `at`. It was the table's only
  // clock, and a name list said nothing about time, correctly by the old rule
  // and uselessly. Adding "at" to the list would have fixed that one name and
  // left the next to be discovered the same way.
  //
  // With one candidate there is nothing to disambiguate.
  assert.equal(recencyColumn(table([["id", "integer"], ["at", "timestamp with time zone"]])), "at");
  assert.equal(recencyColumn(table([["id", "integer"], ["happened", "timestamp"]])), "happened");
  assert.equal(recencyColumn(table([["when_it_landed", "timestamp with time zone"]])), "when_it_landed");
});

test("a single clock whose NAME is not arrival is still refused", () => {
  // What makes "one clock is the clock" safe. A table whose only temporal column
  // is `expires_at` would otherwise report an expiry as the moment data landed —
  // confidently, in the one screen whose job is telling the truth about data.
  for (const name of ["expires_at", "deleted_at", "scheduled_at", "ends_at", "updated_at"]) {
    assert.equal(recencyColumn(table([["id", "integer"], [name, "timestamp with time zone"]])), null, name);
  }
});

test("two clocks nobody can rank leave the view silent", () => {
  // Guessing between two is worse than admitting we cannot tell: the number
  // would look as authoritative as a right one.
  assert.equal(
    recencyColumn(table([["seen_at", "timestamp with time zone"], ["heard_at", "timestamp with time zone"]])),
    null,
  );
});

test("the name is preferred in order, so a table with several is not a coin toss", () => {
  const t = table([
    ["ts", "timestamp with time zone"],
    ["inserted_at", "timestamp with time zone"],
    ["created_at", "timestamp with time zone"],
  ]);
  assert.equal(recencyColumn(t), "created_at", "created_at outranks inserted_at outranks ts");
});

test("the name alone is not enough — a clock has to be a clock", () => {
  // `created_at` holding text is not a clock. `MAX()` over it sorts
  // lexicographically and reports the wrong row as newest, silently.
  assert.equal(recencyColumn(table([["created_at", "text"]])), null);
  assert.equal(recencyColumn(table([["created_at", "date"]])), "created_at");
});

/* ── which order the rows come back in ────────────────────────────────────── */

test("without a clock, a single integer key is the next best claim", () => {
  // Monotonic for anything backed by a sequence, which is what a generated app
  // uses.
  const t = table([["id", "integer"], ["email", "text"]], ["id"]);
  assert.deepEqual(orderingFor(t), { by: "key", column: "id" });
});

test("a uuid key is not an order, and a composite key is not one either", () => {
  // A uuid is random: sorting by it descending returns rows in an order that
  // looks deliberate and means nothing.
  assert.deepEqual(orderingFor(table([["id", "uuid"]], ["id"])), { by: "physical" });
  // Two columns have no combined order that says anything about arrival.
  assert.deepEqual(
    orderingFor(table([["a", "integer"], ["b", "integer"]], ["a", "b"])),
    { by: "physical" },
  );
});

test("physical order is never described as newest first", () => {
  // It usually IS insertion order — and stops being one after an update or a
  // vacuum. Claiming time from it is the kind of small lie that costs trust in
  // the one screen whose job is telling the truth about data.
  const said = describeOrdering({ by: "physical" });
  assert.doesNotMatch(said, /newest/i);
  assert.match(said, /records no arrival time/);
});

test("what the SQL does and what the user is told come from one decision", () => {
  // Two places deciding the same thing is how a screen comes to say "newest
  // first" above rows that are in table order.
  const t = table([["id", "integer"], ["created_at", "timestamp with time zone"]], ["id"]);
  const o = orderingFor(t);
  assert.match(pageQuery(t, o, 50, 0).text, /ORDER BY "created_at" DESC/);
  assert.match(describeOrdering(o), /created_at/);
});

/* ── the query itself ─────────────────────────────────────────────────────── */

test("a table with no ordering claim gets no ORDER BY at all", () => {
  const t = table([["a", "text"]]);
  const sql = pageQuery(t, orderingFor(t), 50, 0);
  assert.doesNotMatch(sql.text, /ORDER BY/);
  assert.match(sql.text, /LIMIT 50 OFFSET 0/);
  assert.deepEqual(sql.values, []);
});

test("nulls sort last, so an empty clock does not fill the first page", () => {
  // `DESC` puts NULLs FIRST in Postgres. A table where the column is optional
  // would open on every row that has no time at all — the least useful rows,
  // presented as the newest.
  const t = table([["created_at", "timestamp with time zone"]]);
  assert.match(pageQuery(t, orderingFor(t), 10, 0).text, /DESC NULLS LAST/);
});

test("an identifier that could carry an injection is refused, not escaped", () => {
  const bad = { name: 'orders"; DROP TABLE users; --', columns: [], primaryKey: [] };
  assert.throws(() => pageQuery(bad, { by: "physical" }, 10, 0), /unsafe table name/);
  const t = table([["a", "text"]]);
  assert.throws(() => pageQuery(t, { by: "recency", column: 'a" DESC, (SELECT 1) --' }, 10, 0),
    /unsafe column name/);
});

/* ── paging ───────────────────────────────────────────────────────────────── */

test("a page is bounded whatever is asked for", () => {
  // The browser cannot draw a hundred thousand rows and the owner did not want
  // them. A cap is the difference between a slow screen and a dead tab.
  assert.equal(pageSize(1_000_000), MAX_PAGE);
  assert.equal(pageSize("25"), 25);
  assert.equal(pageSize(undefined), DEFAULT_PAGE);
  assert.equal(pageSize("nonsense"), DEFAULT_PAGE);
  assert.equal(pageSize(-5), DEFAULT_PAGE);
  assert.equal(pageSize(2.7), 2, "a fractional LIMIT is a syntax error");
});

test("an offset is never negative and never fractional", () => {
  assert.equal(pageOffset(undefined), 0);
  assert.equal(pageOffset(-10), 0);
  assert.equal(pageOffset("100"), 100);
  assert.equal(pageOffset(3.9), 3);
});

/* ── the order the person chose ───────────────────────────────────────────── */

test("a sort on a column this table does not have is dropped, not refused", () => {
  // A link made before a migration is stale, not hostile. Answering it with an
  // error page is worse than answering it with the table.
  const t = table([["id", "integer"], ["email", "text"]], ["id"]);
  assert.deepEqual(parseSort(t, "total", "desc"), { ok: true, value: null });
  assert.deepEqual(parseSort(t, null, null), { ok: true, value: null });
  assert.deepEqual(parseSort(t, "", ""), { ok: true, value: null });
});

test("a sort column that could carry an injection IS refused", () => {
  // The plan's own acceptance test: this has to be turned away by the identifier
  // check, not by Postgres, because by the time Postgres sees it the string is
  // already inside a statement.
  const t = table([["id", "integer"]], ["id"]);
  const out = parseSort(t, "x; DROP TABLE users --", "desc");
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : "", /invalid column name/);
});

test("a direction is normalised rather than rejected", () => {
  // The column is the part that could carry an injection. A direction cannot, so
  // anything that is not `asc` is descending and nobody sees a 400 over a typo.
  const t = table([["id", "integer"]], ["id"]);
  assert.deepEqual(parseSort(t, "id", "asc"), { ok: true, value: { column: "id", dir: "asc" } });
  assert.deepEqual(parseSort(t, "id", "ASC"), { ok: true, value: { column: "id", dir: "asc" } });
  assert.deepEqual(parseSort(t, "id", "sideways"), { ok: true, value: { column: "id", dir: "desc" } });
  assert.deepEqual(parseSort(t, "id", null), { ok: true, value: { column: "id", dir: "desc" } });
});

test("their sort is described as theirs, never as newest first", () => {
  // `describeOrdering` makes a claim about arrival. Somebody sorting `email`
  // ascending is not looking at the newest anything, and the line above the grid
  // must not say so.
  assert.doesNotMatch(describeSort({ column: "email", dir: "asc" }), /newest/i);
  assert.match(describeSort({ column: "email", dir: "asc" }), /email/);
  assert.match(describeSort({ column: "email", dir: "asc" }), /ascending/);
});

test("the person's order wins over ours, and only appears once", () => {
  const t = table([["id", "integer"], ["created_at", "timestamp with time zone"]], ["id"]);
  const sql = pageQuery(t, orderingFor(t), 50, 0, { sort: { column: "id", dir: "asc" } });
  assert.match(sql.text, /ORDER BY "id" ASC NULLS LAST/);
  assert.doesNotMatch(sql.text, /created_at/);
  assert.equal(sql.text.match(/ORDER BY/g)?.length, 1);
});

/* ── the one filter ──────────────────────────────────────────────────────── */

test("an operator not on the list has no path into a statement", () => {
  const t = table([["id", "integer"]], ["id"]);
  const out = parseFilter(t, "id", "; DROP TABLE users --", "1");
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.error : "", /unknown operator/);
  // And every name on the list survives the round trip, so the allow list and
  // the SQL below it cannot drift apart.
  for (const op of FILTER_OPS) {
    const ok = parseFilter(t, "id", op, "1");
    assert.equal(ok.ok, true, op);
  }
});

test("an empty box is not a filter", () => {
  // Somebody who has picked a column and not typed yet is asking for nothing.
  // Hiding rows at that moment answers "is my row there" with "no".
  const t = table([["email", "text"]]);
  assert.deepEqual(parseFilter(t, "email", "eq", ""), { ok: true, value: null });
  assert.deepEqual(parseFilter(t, "email", "contains", null), { ok: true, value: null });
  // Except for the two whose entire meaning is emptiness.
  assert.equal(opTakesValue("null"), false);
  assert.deepEqual(parseFilter(t, "email", "null", ""), {
    ok: true, value: { column: "email", op: "null", value: "" },
  });
});

test("a value is bound, never interpolated", () => {
  const t = table([["email", "text"]]);
  const sql = pageQuery(t, { by: "physical" }, 50, 0, {
    filter: { column: "email", op: "eq", value: "' OR 1=1 --" },
  });
  assert.match(sql.text, /WHERE "email" = \$1/);
  assert.doesNotMatch(sql.text, /OR 1=1/);
  assert.deepEqual(sql.values, ["' OR 1=1 --"]);
});

test("LIKE wildcards in what somebody typed are characters, not wildcards", () => {
  // `order_id` means an underscore. Unescaped it matches any character, so the
  // filter returns MORE rows than asked for — which on this screen means
  // answering "is my row there" with somebody else's row.
  const t = table([["ref", "text"]]);
  const sql = pageQuery(t, { by: "physical" }, 50, 0, {
    filter: { column: "ref", op: "contains", value: "order_1%" },
  });
  assert.deepEqual(sql.values, ["%order\\_1\\%%"]);
  assert.match(sql.text, /"ref"::text ILIKE \$1/);
});

test("IS NULL binds nothing at all", () => {
  const t = table([["shipped_at", "timestamp with time zone"]]);
  const a = pageQuery(t, { by: "physical" }, 50, 0, { filter: { column: "shipped_at", op: "null", value: "" } });
  assert.match(a.text, /WHERE "shipped_at" IS NULL/);
  assert.deepEqual(a.values, []);
  const b = pageQuery(t, { by: "physical" }, 50, 0, { filter: { column: "shipped_at", op: "notnull", value: "" } });
  assert.match(b.text, /WHERE "shipped_at" IS NOT NULL/);
});

test("the total counts the same rows the page is a page of", () => {
  // A total counted without the filter is a total of a different thing, and the
  // footer pages past the end of what it is showing.
  const t = table([["email", "text"]]);
  const f = { column: "email", op: "contains" as const, value: "@example.com" };
  const c = countQuery(t, f);
  assert.match(c.text, /count\(\*\)/);
  assert.match(c.text, /WHERE "email"::text ILIKE \$1/);
  assert.deepEqual(c.values, ["%@example.com%"]);
  // And with no filter it is the plain count, with nothing bound.
  assert.deepEqual(countQuery(t, null).values, []);
});

test("the WHERE comes before the ORDER BY, which is the only order Postgres accepts", () => {
  const t = table([["id", "integer"], ["created_at", "timestamp with time zone"]], ["id"]);
  const sql = pageQuery(t, orderingFor(t), 25, 50, {
    sort: { column: "id", dir: "desc" },
    filter: { column: "id", op: "gt", value: "10" },
  });
  assert.match(sql.text, /FROM "orders" WHERE "id" > \$1 ORDER BY "id" DESC NULLS LAST LIMIT 25 OFFSET 50/);
});

/* ── what may be changed ─────────────────────────────────────────────────── */

test("a table with no primary key cannot be edited at all", () => {
  // The whole reason this is a refusal and not a warning: an UPDATE matched on
  // every other column hits the row's duplicates too, so "change this one" is a
  // promise we would be unable to keep.
  const t = table([["a", "text"], ["b", "text"]], []);
  assert.match(editRefusal(t, t.columns[0])!, /no primary key/);
});

test("the column that names the row is not editable, nor is a generated one", () => {
  const t = table([["id", "integer"], ["slug", "text"], ["searchable", "tsvector"]], ["id"]);
  assert.match(editRefusal(t, { name: "id", type: "integer" })!, /names the row/);
  assert.match(editRefusal(t, { name: "searchable", type: "tsvector", generated: true })!, /generates/);
  // And an ordinary column is editable, which is the point of the other three.
  assert.equal(editRefusal(t, { name: "slug", type: "text" }), null);
});

test("arrays and binary are refused, because the cell shows a rendering of them", () => {
  // What the panel draws for these is not the database's own text, so what
  // somebody typed back would not be what they were shown.
  const t = table([["id", "integer"], ["tags", "ARRAY"], ["blob", "bytea"]], ["id"]);
  assert.match(editRefusal(t, { name: "tags", type: "ARRAY" })!, /arrays/);
  assert.match(editRefusal(t, { name: "tags", type: "_text" })!, /arrays/);
  assert.match(editRefusal(t, { name: "blob", type: "bytea" })!, /binary/);
});

test("a partial key is refused: it names a set of rows, not a row", () => {
  const t = table([["order_id", "integer"], ["sku", "text"], ["qty", "integer"]], ["order_id", "sku"]);
  assert.equal(checkKey(t, { order_id: 3 }).ok, false);
  assert.equal(checkKey(t, { order_id: 3, sku: "A" }).ok, true);
  // And a key carrying something that is not part of it is refused rather than
  // quietly ignored — an ignored extra reads as a narrower match than happened.
  const extra = checkKey(t, { order_id: 3, sku: "A", qty: 1 });
  assert.equal(extra.ok, false);
  assert.match(extra.ok === false ? extra.error : "", /qty/);
});

test("a key that is not an object at all is refused", () => {
  const t = table([["id", "integer"]], ["id"]);
  for (const bad of [null, undefined, 3, "id=3", [1]]) {
    assert.equal(checkKey(t, bad).ok, false, JSON.stringify(bad));
  }
});

test("the old value is in the WHERE, so two tabs cannot silently overwrite", () => {
  const t = table([["id", "integer"], ["status", "text"]], ["id"]);
  const sql = updateRowQuery(t, "status", { id: 7 }, "pending", "shipped");
  assert.match(sql.text, /UPDATE "orders" SET "status" = \$1/);
  assert.match(sql.text, /WHERE "id" = \$3/);
  // IS NOT DISTINCT FROM and not `=`: `=` is never true of NULL, so a cell
  // reading `null` could never be changed — and a WHERE that matches nothing
  // looks exactly like somebody else getting there first.
  assert.match(sql.text, /AND "status" IS NOT DISTINCT FROM \$2/);
  assert.match(sql.text, /RETURNING \*/);
  assert.deepEqual(sql.values, ["shipped", "pending", 7]);
});

test("a composite key puts every column in the WHERE, in order", () => {
  const t = table([["order_id", "integer"], ["sku", "text"], ["qty", "integer"]], ["order_id", "sku"]);
  const sql = updateRowQuery(t, "qty", { sku: "A", order_id: 3 }, 1, 2);
  assert.match(sql.text, /WHERE "order_id" = \$3 AND "sku" = \$4/);
  assert.deepEqual(sql.values, [2, 1, 3, "A"]);
});

test("an identifier that could carry an injection cannot reach an UPDATE", () => {
  const t = table([["id", "integer"], ["a", "text"]], ["id"]);
  assert.throws(() => updateRowQuery(t, 'a" = 1, "id', { id: 1 }, "x", "y"), /unsafe column name/);
  const badTable = { name: 'orders"; DROP TABLE users --', columns: [], primaryKey: ["id"] };
  assert.throws(() => updateRowQuery(badTable, "a", { id: 1 }, "x", "y"), /unsafe table name/);
  const keyless = table([["a", "text"]], []);
  assert.throws(() => updateRowQuery(keyless, "a", {}, "x", "y"), /no primary key/);
});
