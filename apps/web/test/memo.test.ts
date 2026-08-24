import test from "node:test";
import assert from "node:assert/strict";
import { memo, forget, forgetPrefix, _memoForTesting } from "@/lib/memo";

test("a second call inside the window does not run the work again", async () => {
  _memoForTesting.clear();
  let calls = 0;
  const get = async () => ++calls;
  assert.equal(await memo("k", 10_000, get), 1);
  assert.equal(await memo("k", 10_000, get), 1);
  assert.equal(calls, 1);
});

test("concurrent callers share ONE round trip", async () => {
  // The case this exists for: the Dev screen fires nine reads in the same tick.
  // Caching the value rather than the promise would let all nine start before
  // the first one finished, which is nine requests and no cache at all.
  _memoForTesting.clear();
  let calls = 0;
  const get = () => {
    calls++;
    return new Promise<number>((r) => setTimeout(() => r(calls), 5));
  };
  const all = await Promise.all([memo("s", 10_000, get), memo("s", 10_000, get), memo("s", 10_000, get)]);
  assert.deepEqual(all, [1, 1, 1]);
  assert.equal(calls, 1);
});

test("a rejection is not remembered", async () => {
  // Caching a failure turns one unlucky moment into a screen that stays broken
  // for the whole TTL — and the retry button would answer from the cache.
  _memoForTesting.clear();
  let calls = 0;
  const get = async () => {
    calls++;
    if (calls === 1) throw new Error("nope");
    return "second";
  };
  await assert.rejects(memo("f", 10_000, get));
  assert.equal(await memo("f", 10_000, get), "second");
  assert.equal(calls, 2);
});

test("a zero window is no cache", async () => {
  _memoForTesting.clear();
  let calls = 0;
  const get = async () => ++calls;
  await memo("z", 0, get);
  await memo("z", 0, get);
  assert.equal(calls, 2);
});

test("forget drops one key, forgetPrefix drops a family", async () => {
  _memoForTesting.clear();
  let calls = 0;
  const get = async () => ++calls;
  await memo("app:a:env", 10_000, get);
  await memo("app:a:db", 10_000, get);
  await memo("app:b:env", 10_000, get);
  assert.equal(_memoForTesting.size(), 3);

  forget("app:a:env");
  assert.equal(_memoForTesting.size(), 2);

  forgetPrefix("app:a");
  assert.equal(_memoForTesting.size(), 1);
});
