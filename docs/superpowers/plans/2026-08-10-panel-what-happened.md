# Panel "What happened" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw the reading's durable half — `builds` and `since.builds` — in the x-ray panel, which today renders only `d.live`.

**Architecture:** The panel is not a module. It is two exported strings, `XRAY_CSS` and `XRAY_JS`, in `services/proxy/src/xray-panel.ts`, imported by both `xray-page.ts:2` (the standalone `/_xray` page) and `inject.ts:2` (the overlay injected into an app's HTML). Editing the strings changes both surfaces at once; that is why the file exists. The JS is ES5-flavoured (`var`, `function`, no arrow functions, no template literals) because it is emitted verbatim into a tenant's page, and it is written inside `String.raw` so backslashes survive. All work is a fourth `sec()` block appended after `Breaks`, plus two time helpers and one swallowed-error fix.

**Tech Stack:** TypeScript, `node:test`, `tsx`. No dependencies added.

## Global Constraints

- **Never write a backtick or `${` inside `XRAY_JS` or `XRAY_CSS`.** Both are `String.raw` template literals; either character ends or interpolates the literal. A stray backtick inside `String.raw` broke the build in a prior session.
- **Never write `*/` inside `XRAY_JS`, including in a comment.** A literal `Accept: */*` in a JSDoc block closed the comment early and broke the build in the session before that. Use `//` comments inside the panel source.
- **Prefer ASCII in panel copy over escapes.** Rephrase to avoid an apostrophe rather than writing `’`. Prose inside code is checked by nothing.
- **The panel's JS is ES5-flavoured.** `var`, `function(){}`, string concatenation. Match it; do not introduce `let`, `const`, arrows, or template literals into the emitted string.
- **Field names come from `assembleReading`, never from this document.** Every test builds its input by calling `assembleReading` with fake deps, so a rename in `reading.ts` fails the test instead of reaching owners.
- **Run tests from `services/proxy`.** Full suite `npm test`; one file `node --import tsx --test src/xray-panel.test.ts`.
- **Do not push.** Work stays on branch `panel-what-happened`. Every push to `main` deploys production.

---

### Task 1: Stop the poll swallowing draw errors

`pullXray` ends in `.catch(function(){})`. Carried in §5.3 of the 10 Aug handoff as a known debt, and it is a prerequisite here rather than a cleanup: Task 3 adds a branch that reads a field the poll supplies, and this is the exact `.catch` that hid the identical `d.here` / `d.live` mismatch described in §4 — the panel drew once, stopped for every owner, and left a healthy 200 in the network tab with nothing in the console.

**Files:**
- Modify: `services/proxy/src/xray-panel.ts:118-120`
- Test: `services/proxy/src/xray-panel.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks call. Behavioural only.

- [ ] **Step 1: Write the failing test**

Append to `services/proxy/src/xray-panel.test.ts`:

```ts
test("the poll reports a draw error instead of swallowing it", () => {
  // The empty catch is why the d.here/d.live regression reached a browser and
  // stayed invisible: drawXray threw, the catch ate it, and the panel simply
  // stopped refreshing. The owner is a developer; the console is the right
  // place for this.
  assert.doesNotMatch(XRAY_JS, /\.catch\(\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/);
  assert.match(XRAY_JS, /console\.error/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && node --import tsx --test src/xray-panel.test.ts`
Expected: FAIL — the first assertion matches the empty catch still in the source.

- [ ] **Step 3: Write minimal implementation**

Replace `services/proxy/src/xray-panel.ts:118-120` with:

```js
function pullXray(){
  // Never swallowed. A mismatch between what /_xray serves and what drawXray
  // reads throws here, and an empty catch turns that into a panel that drew
  // once and stopped -- a healthy 200 in the network tab and nothing anywhere
  // else. Reporting it costs a line and is the only signal this surface has.
  fetch('/_xray',{credentials:'include'}).then(function(r){return r.json()}).then(drawXray).catch(function(e){console.error('x-ray:',e)});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/proxy && node --import tsx --test src/xray-panel.test.ts`
Expected: PASS, including the five tests that were already there.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/xray-panel.ts services/proxy/src/xray-panel.test.ts
git commit -m "Panel: report poll errors instead of swallowing them"
```

---

### Task 2: Time helpers that reach past hours

The row added in Task 3 needs two things `ago()` cannot do. It tops out at hours (`xray-panel.ts:50`), which was right while it only described live traffic but wrong for durable builds — `zpjsb` has been stuck since 2 Aug, and "216h ago" is not a reading. And an in-flight build wants a duration, not "12m ago".

Defining `ago` in terms of `dur` means the two cannot drift and the days branch is written once.

**Files:**
- Modify: `services/proxy/src/xray-panel.ts:50`
- Test: `services/proxy/src/xray-panel.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: two functions inside `XRAY_JS`, used by Task 3.
  - `dur(sec: number) -> string` — `"45s"`, `"12m"`, `"5h"`, `"8d"`
  - `ago(sec: number) -> string` — `dur(sec) + " ago"`

- [ ] **Step 1: Write the failing test**

Append to `services/proxy/src/xray-panel.test.ts`:

```ts
/**
 * Pulls the helpers out of the shipped source and calls them. XRAY_JS is only
 * function declarations and two `var`s at top level, so it evaluates with no
 * host at all -- `h`, `C` and `root` are referenced inside function bodies,
 * never at parse time.
 */
function helpers(): { dur: (s: number) => string; ago: (s: number) => string } {
  return new Function(`${XRAY_JS}
    return { dur: dur, ago: ago };`)();
}

test("dur reads as a duration and reaches past hours", () => {
  const { dur } = helpers();
  assert.equal(dur(45), "45s");
  assert.equal(dur(720), "12m");
  assert.equal(dur(18000), "5h");
  // A build stuck since 2 Aug is the reason this branch exists at all.
  assert.equal(dur(691200), "8d");
});

test("ago is dur plus a suffix, so the two cannot drift", () => {
  const { dur, ago } = helpers();
  for (const s of [45, 720, 18000, 691200]) {
    assert.equal(ago(s), dur(s) + " ago");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/proxy && node --import tsx --test src/xray-panel.test.ts`
Expected: FAIL — `dur is not defined` inside the evaluated source.

- [ ] **Step 3: Write minimal implementation**

Replace `services/proxy/src/xray-panel.ts:50` (the single `function ago(sec){...}` line) with:

```js
function dur(sec){ if(sec<60)return sec+'s'; if(sec<3600)return Math.round(sec/60)+'m'; if(sec<86400)return Math.round(sec/3600)+'h'; return Math.round(sec/86400)+'d'; }
function ago(sec){ return dur(sec)+' ago'; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/proxy && node --import tsx --test src/xray-panel.test.ts`
Expected: PASS. The `Speed` and `Breaks` sections call `ago()` and are covered by the existing draw tests, which must stay green — behaviour below one day is unchanged.

- [ ] **Step 5: Commit**

```bash
git add services/proxy/src/xray-panel.ts services/proxy/src/xray-panel.test.ts
git commit -m "Panel: add dur(), and let ago() reach past hours"
```

---

### Task 3: The "What happened" section

Four states, decided in this order. The order is the design: "not read yet" must be tested before the window, and the window before emptiness, or a state borrows another state's words and the panel lies.

**Files:**
- Modify: `services/proxy/src/xray-panel.ts` — append a block after the `Breaks` section (currently ends at `:115` with `xr.appendChild(s3);`), inside `drawXray`
- Test: `services/proxy/src/xray-panel.test.ts`

**Interfaces:**
- Consumes: `dur(sec)` and `ago(sec)` from Task 2.
- Produces: nothing later tasks call. This is the last task.
- Reads, from the object `assembleReading` returns: `d.builds` (`Tick[]`, may be absent on the placeholder) and `d.since.builds` (`"durable" | "unreadable"`). A `Tick` is `{ runId, who, startedAt, endedAt, outcome, linesGone }` — see `services/proxy/src/builds.ts:17`.

- [ ] **Step 1: Write the failing tests**

First add a text collector near `runDrawXray` in `services/proxy/src/xray-panel.test.ts`. The existing tests assert only "does not throw", which cannot tell four states apart:

```ts
/**
 * Every string the fake host was given, so a test can assert which of the four
 * states was drawn rather than only that drawing survived.
 *
 * `cellsOf` keeps them separate on purpose. Joined into one blob, an assertion
 * for "failed" also passes on the Breaks section's "Nothing has failed." — a
 * test that looks strict and checks nothing. Cell equality cannot do that.
 */
function cellsOf(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (typeof n.textContent === "string") out.push(n.textContent);
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

const textOf = (node: unknown): string => cellsOf(node).join(" ");
```

Then append:

```ts
const liveNone = { since: 1000, here: { count: 0, names: [] }, paths: [], dropped: 0 };
const door = async () => ({ door: "lilna.supersonic.cv", open: true });

test("an unreadable durable half says so, and never reads as never-built", async () => {
  const reading = await assembleReading("lilna", {
    xray: () => liveNone,
    listBuilds: async () => null,
    door,
  });
  assert.equal(reading.since.builds, "unreadable");
  const text = textOf(runDrawXray(reading));
  assert.match(text, /Could not read/);
  assert.doesNotMatch(text, /never been built/);
});

test("an empty durable half states the fact", async () => {
  const reading = await assembleReading("new", {
    xray: () => liveNone,
    listBuilds: async () => [],
    door: async () => ({ door: "new.supersonic.cv", open: false }),
  });
  assert.match(textOf(runDrawXray(reading)), /never been built/);
});

test("builds draw who, and each outcome state distinctly", async () => {
  const now = Date.now();
  const reading = await assembleReading("lilna", {
    xray: () => liveNone,
    listBuilds: async () => [
      { runId: "r1", who: "you", startedAt: now - 60_000, endedAt: now - 30_000, outcome: "ok", linesGone: false },
      { runId: "r2", who: "agent", startedAt: now - 120_000, endedAt: now - 90_000, outcome: "failed", linesGone: false },
      { runId: "r3", who: "platform", startedAt: now - 300_000, endedAt: null, outcome: null, linesGone: false },
      { runId: "r4", who: "someone", startedAt: now - 900_000, endedAt: now - 800_000, outcome: null, linesGone: true },
    ],
    door,
  });
  const cells = cellsOf(runDrawXray(reading));
  // Exact cells, not a substring search over the whole panel.
  for (const who of ["you", "agent", "platform", "someone"]) assert.ok(cells.includes(who), who);
  assert.ok(cells.includes("ok"));
  assert.ok(cells.includes("failed"));
  // A dispatched build that never starts reads in-flight forever (handoff
  // 5.3). It must look stuck, not busy, so the elapsed time is on the row.
  assert.ok(cells.includes("in flight, 5m"));
  // outcome null with endedAt set is the shape a finishBuild that never fires
  // would leave behind (handoff 4). If it ever appears it must not read as ok,
  // and the pruned marker rides on the same cell.
  assert.ok(cells.includes("ended, unrecorded · lines pruned"));
});

test("the placeholder draws not-read-yet, not never-built", () => {
  const call = /drawXray\((\{[\s\S]*?\})\);\s*\n\s*pullXray/.exec(XRAY_JS);
  assert.ok(call, "the placeholder drawXray(...) call was not found in XRAY_JS");
  const placeholder = new Function(`return ${call![1]};`)();
  const text = textOf(runDrawXray(placeholder));
  assert.match(text, /Reading/);
  assert.doesNotMatch(text, /never been built/);
});

test("the panel reads the reading's durable half", () => {
  assert.match(XRAY_JS, /d\.builds/);
  assert.match(XRAY_JS, /d\.since\.builds/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/proxy && node --import tsx --test src/xray-panel.test.ts`
Expected: FAIL — no section draws any of this copy yet.

- [ ] **Step 3: Write the implementation**

In `services/proxy/src/xray-panel.ts`, inside `drawXray`, after the line `xr.appendChild(s3);` and before the closing `}`:

```js
  // what happened
  //
  // The durable half. Four states, and the order they are tested in is the
  // point: each has its own words, and none is allowed to borrow another's.
  var s4=sec('What happened');
  if(!d.builds){
    // Not read yet. The placeholder toggleXray paints carries no builds key,
    // and inventing an empty list for it would draw "never been built" over an
    // app that has shipped a hundred times, for one frame, every time the panel
    // opens. This branch also absorbs an older-shaped object, which is how the
    // live half broke once already.
    s4.appendChild(h('div','none','Reading...'));
  } else if(d.since.builds==='unreadable'){
    // Never flattened into an empty list. A database that will not answer is
    // not a fact about this app, and the window beside the list exists to keep
    // those two apart.
    s4.appendChild(h('div','none','Could not read the build history for this app.'));
  } else if(!d.builds.length){
    s4.appendChild(h('div','none','This app has never been built.'));
  } else {
    var t3=document.createElement('table');
    var bnow=Date.now();
    d.builds.slice(0,8).forEach(function(b){
      var since=Math.round((bnow-b.startedAt)/1000);
      var tr=document.createElement('tr');
      tr.appendChild(h('td','p',ago(since)));
      // Printed verbatim: you, agent, platform, someone. "someone" means
      // nobody said, and dressing it up as anything else is the one thing this
      // column must never do.
      tr.appendChild(h('td','n',b.who));
      var out,cls;
      if(b.outcome==='ok'){ out='ok'; cls='n'; }
      else if(b.outcome==='failed'){ out='failed'; cls='n bad'; }
      // Elapsed rather than a spinner: a build stuck for a week should look
      // wrong, not busy.
      else if(b.endedAt===null){ out='in flight, '+dur(since); cls='n'; }
      // Ended without an outcome should be impossible. It is drawn, and drawn
      // as bad, because the alternative is that it reads as success.
      else { out='ended, unrecorded'; cls='n bad'; }
      if(b.linesGone) out+=' · lines pruned';
      tr.appendChild(h('td',cls,out));
      t3.appendChild(tr);
    });
    s4.appendChild(t3);
  }
  xr.appendChild(s4);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/proxy && node --import tsx --test src/xray-panel.test.ts`
Expected: PASS, all of them, including the five that predate this plan.

- [ ] **Step 5: Check the whole suite and the types**

Run: `cd services/proxy && npm test`
Expected: PASS — 135 before this plan, plus the tests added here.

Run: `cd services/proxy && npx tsc --noEmit`
Expected: no output.

Then confirm the two characters that have broken this build before are still
where they belong. `tsc` catches both, so this is a reading of *why* if it goes
red, not a second gate:

```bash
cd services/proxy
grep -n '[*]/' src/xray-panel.ts          # expect: only inside the file's own /** */ doc blocks, never inside XRAY_JS
grep -c '[`]' src/xray-panel.ts           # expect: 4 -- the lines opening and closing each String.raw literal
```

- [ ] **Step 6: Commit**

```bash
git add services/proxy/src/xray-panel.ts services/proxy/src/xray-panel.test.ts
git commit -m "Panel: draw what happened, and who did it"
```

---

## After the plan

Two corrections to `~/supersonic-handoff-2026-08-10.md` fall out of this work and belong in the next handoff rather than in this branch:

- §5.3 says favicon 404s will *top* the `Breaks` section. They will not: `paths` are sorted by `p95` descending (`xray.ts:151`) and `Breaks` inherits that order, so a fast 404 sorts last. The real problem is that when nothing else fails, favicon 404s are the whole section — which is a decision about what counts as an error, not a sort.
- §5.3's "`pullXray` swallows any draw error" is closed by Task 1.
