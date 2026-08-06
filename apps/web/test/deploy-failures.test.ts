import { test } from "node:test";
import assert from "node:assert/strict";
import {
  causeOf, NO_REASON, FailureRecorder,
  type FailureRow, type FailureSink, type Repair,
} from "../lib/deploy-failures";
import { classify } from "../lib/deploy-errors";

function recordingSink() {
  const rows: FailureRow[] = [];
  const repairs: { id: string; repair: Repair; summary: string | null }[] = [];
  const sink: FailureSink = {
    async insert(r) { rows.push(r); return `id-${rows.length}`; },
    async setRepair(id, repair, summary) { repairs.push({ id, repair, summary }); },
  };
  return { sink, rows, repairs };
}

const row = (over: Partial<FailureRow> = {}): FailureRow => ({
  runId: "run-1", slug: "abc12", ownerId: "owner-1",
  stage: "build", cause: "Build failed:\nmissing module", blame: "app", ...over,
});

test("causeOf keeps a real reason exactly as it was", () => {
  assert.equal(causeOf("Build failed:\nmissing module"), "Build failed:\nmissing module");
});

test("causeOf turns a blank reason into the not-captured sentence", () => {
  // `??` guards null and lets "" through, which is how six of twenty-three
  // recorded failures ended up saying nothing at all. Whitespace counts as blank:
  // a row containing a newline is no more of a cause than an empty one.
  for (const blank of [null, undefined, "", "   ", "\n\t"]) {
    assert.equal(causeOf(blank), NO_REASON);
  }
});

test("the not-captured sentence is one exact string", () => {
  // The success criterion counts rows carrying it. Two spellings would count as
  // one reporting gap and one real cause.
  assert.equal(NO_REASON, "no reason captured — this is a reporting gap, not a cause");
});

test("recording a failure writes one row, as given", async () => {
  const { sink, rows } = recordingSink();
  await new FailureRecorder(sink).record(row());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], row());
});

test("the repair outcome updates the row that was inserted", async () => {
  // Not a second row: a failed-then-repaired attempt is one attempt.
  const { sink, rows, repairs } = recordingSink();
  const r = new FailureRecorder(sink);
  await r.record(row());
  await r.repaired("gave-up", "opencode couldn't get it live after 2 redeploys");
  assert.equal(rows.length, 1);
  assert.deepEqual(repairs, [{ id: "id-1", repair: "gave-up", summary: "opencode couldn't get it live after 2 redeploys" }]);
});

test("a repair outcome with nothing recorded is dropped, not invented", async () => {
  // If the insert failed, there is no row to update. Inventing one would put a
  // repair verdict in the table with no cause beside it — the exact shape this
  // table exists to stop.
  const { sink, repairs } = recordingSink();
  await new FailureRecorder(sink).repaired("fixed", "fixed it");
  assert.deepEqual(repairs, []);
});

test("a sink that throws costs the record, never the deploy", async () => {
  const errors: unknown[] = [];
  const exploding: FailureSink = {
    async insert() { throw new Error("database is down"); },
    async setRepair() { throw new Error("database is down"); },
  };
  const r = new FailureRecorder(exploding, (e) => errors.push(e));
  await assert.doesNotReject(() => r.record(row()));
  await assert.doesNotReject(() => r.repaired("fixed", "fixed it"));
  assert.equal(errors.length, 1, "the insert threw and was reported; the repair had no row to update");
});

test("the blame stored is whatever classify returned, not a copy of its rules", () => {
  // classify carries a PLATFORM_MARKERS list and an `app` fallback. A second
  // implementation of "is this the platform's fault" would drift from it, and the
  // drift would be invisible: both answers are plausible strings.
  // Must be a string `classify` genuinely matches, not one that merely looks
  // like a platform failure: a fixture picked from a truncated log excerpt is
  // not evidence of what the function returns, only of what got displayed.
  // IAM_FAILURE is a marker classify actually recognizes (see PLATFORM_MARKERS
  // in lib/deploy-errors.ts).
  const platform = "IAM_FAILURE: the deploy service account is missing a role";
  const app = "SyntaxError: unexpected token";
  assert.equal(classify(platform).blame, "platform");
  assert.equal(classify(app).blame, "app");
});

test("a failure with no error text is recorded as a platform failure with the not-captured cause", async () => {
  // The two halves of the same six rows: classify already calls a reasonless
  // failure the platform's fault, and causeOf gives it a cause that says so.
  const { sink, rows } = recordingSink();
  await new FailureRecorder(sink).record(row({ cause: causeOf(""), blame: classify("").blame }));
  assert.equal(rows[0].cause, NO_REASON);
  assert.equal(rows[0].blame, "platform");
});
