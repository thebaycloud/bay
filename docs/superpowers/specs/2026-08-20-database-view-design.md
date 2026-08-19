# The database view — design

20 Aug 2026. Replaces the two-pane browser in `components/DatabasePanel.tsx`
with a view that answers the owner's question instead of a DBA's.

---

## 1. Who this is for

Supabase's table editor is a tool for someone who MANAGES a database. Our owner
deployed with one prompt and never chose to have one. Their question is not
"what is the schema" — it is **"did the data land?"**: are signups being
written, did that order save, is anything arriving at all.

Every decision below follows from that, and the shape is the panel's own: each
table is a `Cell` in the dev-mode grid, carrying the two facts that answer the
question, and pushing into its rows.

---

## 2. What a cell may say, and how it knows

Two facts, and both are harder than they look. The rule that governs both: **a
number we cannot vouch for is labelled, and a fact we do not have is omitted
rather than invented.**

### The count

Today it reads `pg_stat_user_tables.n_live_tup` and prints it as fact. That is
an ESTIMATE maintained by the stats collector: it is **zero** for a table
autovacuum has not reached — which is precisely the state a fresh app is in when
its owner asks whether the data landed. The panel answers "0 rows" about a table
with rows in it.

`COUNT(*)`, exact, under a statement timeout. On timeout, fall back to the
estimate AND mark it approximate (`~1,200`). A number whose accuracy is unknown
is how this was wrong the first time.

### The freshness

Postgres has no general "when was this last written". The honest route is a
timestamp column, and only if one exists:

- a column whose type is `timestamp`/`timestamptz`/`date`, and
- whose name is one of `created_at`, `inserted_at`, `created`, `inserted`,
  `added_at`, `ts`, `time`, `timestamp` — in that order of preference.

With one, the cell says `last 4 minutes ago`. Without one, **the cell says
nothing about time.** That silence is the feature: it is a refusal to invent,
and both `orders · 128 rows · last 4 minutes ago` and `sessions · 4 rows` are
true statements.

`updated_at` is deliberately NOT in the list. It answers "when did a row last
change", which for the owner's question reads as arrival and is not.

### The order rows come back in

A table has no inherent order, and `SELECT *` returns physical order — roughly
insertion order for an append-only table, and not after an update or a vacuum.
Newest-first is the whole point of the view, so it is chosen explicitly, in
this order:

1. the recency column above, `DESC`
2. the primary key `DESC`, when it is a single integer column — monotonic for
   anything using a sequence, which is what a generated app uses
3. physical order — and the view SAYS SO, rather than presenting it as time

---

## 3. The route

`app/api/apps/[slug]/db/route.ts` keeps its shape: GET lists or reads, POST runs
a read-only query. What changes is what it answers and what it protects.

**Listing** gains, per table: `rows`, `rowsExact`, `lastWriteAt`,
`recencyColumn`, `orderedBy`.

**Reading a table** gains `limit`/`offset` (default 50, capped at 200), returns
column TYPES beside names, the total, and the ordering actually used — so the UI
can say "newest first" or "in table order" truthfully rather than assuming.

**Three protections, none of which exist today:**

- **A statement timeout on every tenant query.** The tenant pool holds three
  connections. Three slow queries and the view is wedged for everyone looking at
  that app. `SET LOCAL statement_timeout` inside a transaction, so it cannot
  leak to another borrower of the same connection.
- **Existence checked, not just shape.** The table name is matched against
  `information_schema.tables` before it is interpolated. The regex stays — it is
  what makes interpolation safe at all — but a name that passes the regex and
  does not exist should produce "no such table", not a Postgres syntax error.
- **A cap on `limit`.** An owner glancing at recent rows does not need 100,000 of
  them, and the browser cannot draw them.

---

## 4. Where the decisions live

`lib/db-browse.ts`: which column carries recency, which ordering follows from a
schema, and the SQL that expresses both. Pure functions over a description of a
table — no database — so every rule above is testable without one, which is the
only way rules like "prefer `created_at` over `ts`, and never `updated_at`" stay
true a month from now.

The route keeps the I/O and the permission check. The panel keeps the drawing.

---

## 5. What this deliberately does not do

**No writing.** Not cell edits, not inserts, not deletes. The workbench spec's
rule holds and is stronger here than for chat: this is a customer's production
data, and the first version earns trust before it spends it.

**No schema surface.** No foreign keys, no indexes, no DDL. They answer a
question the owner did not ask; the drill-down shows column types because a
column of unreadable values needs its type explained, and stops there.

**No filtering.** Sorting by a column is one click on a header and follows from
the ordering machinery already needed. A filter builder is a query language in a
UI, and the SQL box below already is one, for the person who wants that.

**The SQL box stays, demoted.** It is an escape hatch, not the interface. Read-
only and one statement, unchanged.
