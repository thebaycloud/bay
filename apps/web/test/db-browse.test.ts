import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recencyColumn, orderingFor, describeOrdering, pageQuery,
  pageSize, pageOffset, MAX_PAGE, DEFAULT_PAGE,
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
  assert.match(pageQuery(t, o, 50, 0), /ORDER BY "created_at" DESC/);
  assert.match(describeOrdering(o), /created_at/);
});

/* ── the query itself ─────────────────────────────────────────────────────── */

test("a table with no ordering claim gets no ORDER BY at all", () => {
  const t = table([["a", "text"]]);
  const sql = pageQuery(t, orderingFor(t), 50, 0);
  assert.doesNotMatch(sql, /ORDER BY/);
  assert.match(sql, /LIMIT 50 OFFSET 0/);
});

test("nulls sort last, so an empty clock does not fill the first page", () => {
  // `DESC` puts NULLs FIRST in Postgres. A table where the column is optional
  // would open on every row that has no time at all — the least useful rows,
  // presented as the newest.
  const t = table([["created_at", "timestamp with time zone"]]);
  assert.match(pageQuery(t, orderingFor(t), 10, 0), /DESC NULLS LAST/);
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
