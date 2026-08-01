import { test } from "node:test";
import assert from "node:assert/strict";
import { eventSink, eventLine } from "../lib/deploy-events";

/** Collect the batches a sink writes, in the order they are written. */
function recorder(delays: number[] = []) {
  const batches: unknown[][] = [];
  let call = 0;
  return {
    batches,
    events: () => batches.flat(),
    append: async (events: unknown[]) => {
      const wait = delays[call++] ?? 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      batches.push(events);
    },
  };
}

test("a terminal event is durable before the sink says it is", async () => {
  // This is the property the whole design rests on: the reader of a deploy is
  // waiting on `done`/`error`, so one still sitting in a buffer when the job
  // process exits is a deploy that finished and never told anyone.
  const rec = recorder();
  const sink = eventSink("run-1", "abc12", { append: rec.append, intervalMs: 60_000 });

  sink.emit({ type: "log", line: "installing…" });
  assert.deepEqual(rec.batches, [], "an ordinary line waits for the timer");

  sink.emit({ type: "done", slug: "abc12", url: "https://abc12.supersonic.cv" });
  await sink.drain();
  assert.deepEqual(rec.events(), [
    { type: "log", line: "installing…" },
    { type: "done", slug: "abc12", url: "https://abc12.supersonic.cv" },
  ], "the terminal event flushes immediately, and takes the buffered line with it");
});

test("an error ends the wait just as surely as a success", async () => {
  const rec = recorder();
  const sink = eventSink("run-2", "abc12", { append: rec.append, intervalMs: 60_000 });
  sink.emit({ type: "error", message: "build failed" });
  await sink.drain();
  assert.deepEqual(rec.events(), [{ type: "error", message: "build failed" }]);
});

test("batches land in the order they were emitted, even when a write is slow", async () => {
  // Readers page through the log by id, so a batch that overtakes an earlier one
  // shows a customer their build out of order — and, worse, could put `done`
  // ahead of the failure that preceded it.
  const rec = recorder([40, 0]);   // the first write is the slow one
  const sink = eventSink("run-3", "abc12", { append: rec.append, intervalMs: 60_000, maxBatch: 2 });

  sink.emit({ n: 1 }); sink.emit({ n: 2 });       // fills maxBatch → flushes (slow)
  sink.emit({ n: 3 }); sink.emit({ n: 4 });       // fills again → flushes (fast)
  await sink.drain();

  assert.deepEqual(rec.events(), [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
});

test("a full buffer flushes without waiting for the timer", async () => {
  // Build output arrives in bursts of dozens of lines in a few milliseconds. If
  // only the timer flushed, a watching client would see the build in lurches.
  const rec = recorder();
  const sink = eventSink("run-4", "abc12", { append: rec.append, intervalMs: 60_000, maxBatch: 3 });
  sink.emit({ n: 1 }); sink.emit({ n: 2 }); sink.emit({ n: 3 });
  await sink.drain();
  assert.equal(rec.batches.length, 1);
  assert.equal(rec.batches[0].length, 3);
});

test("draining an idle sink is a no-op, not a write", async () => {
  const rec = recorder();
  const sink = eventSink("run-5", "abc12", { append: rec.append });
  await sink.drain();
  assert.deepEqual(rec.batches, [], "an empty batch must never be written");
});

test("the narration a user never saw is readable back as lines", () => {
  // These are the exact events y7ux3 emitted on 1 Aug and nobody ever saw: the
  // stream they went to ended when `deploy` returned, a second after it started.
  assert.equal(eventLine({ type: "log", line: "Repair agent taking over — reading the repo, fixing, retrying…" }),
    "Repair agent taking over — reading the repo, fixing, retrying…");
  assert.equal(eventLine({ type: "error", message: "the container didn't start on $PORT" }),
    "✕ the container didn't start on $PORT");
});

test("events that are structure rather than prose stay out of the log", () => {
  // A terminal cannot use these, and printing them raw is how a log becomes
  // something people stop reading.
  assert.equal(eventLine({ type: "detected", stack: { language: "node" } }), null);
  assert.equal(eventLine({ type: "done", url: "https://x.supersonic.cv" }), null);
  assert.equal(eventLine({ type: "log" }), null);
  assert.equal(eventLine({}), null);
});
