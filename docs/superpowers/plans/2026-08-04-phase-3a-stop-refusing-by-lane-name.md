# Phase 3A: Stop refusing apps by a lane name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An app that built a real image with a resolvable digest becomes placeable on the fleet, whatever its lane is called.

**Architecture:** `fleetEligibility` refuses `lane === "buildpack"` because a buildpack image is named by Cloud Run during the deploy, so there is nothing to hand a node. That is true only when the app really took the `--source` path. The pipeline writes a Dockerfile in three places — a generated one, an SPA fallback and a Next.js fallback — and all three happen *before* `chooseRuntime` runs, so those apps have a Dockerfile on disk and build a normal image with a digest while still carrying the lane label `buildpack`. The refusal gets one more input: whether a Dockerfile exists in the checkout.

**Tech Stack:** TypeScript on Node 22 with `node:test` (`apps/web`).

## Why this is the first piece of phase 3

It is the only item in that phase that adds no capability. Nothing is built, nothing is deleted, no new failure mode appears — a set of apps that already produce exactly what the fleet needs stops being turned away by a string that no longer describes how they were built. Everything else in phase 3 (replacing the runner lane, teaching buildpack to build, moving siblings) is real work with real risk.

## The ordering that makes it true, verified in the file

| line | what happens |
|---|---|
| ~1701, 1817 | a Dockerfile is generated when the app has none and `RUNNER=0` or the runtime is pinned |
| ~1930 | the SPA fallback Dockerfile is written |
| ~1933 | the Next.js fallback Dockerfile is written |
| ~2087 | `chooseRuntime` is called |
| ~2381 | `useDockerBuild = existsSync(join(dir, "Dockerfile"))` — the build path asks the same question, later |

The lane is decided before all of these. `useDockerBuild` at ~2381 is the pipeline asking, at build time, precisely the question `fleetEligibility` needs at ~2087 and does not ask.

## Global Constraints

- **Never squash commits.** One commit per change.
- **Never print secrets.** Not in logs, not in test output, not in a commit.
- **Every push to `main` deploys the control plane to production.** There is no staging.
- **Never put a pipe inside an `&&` chain that gates a decision** — the chain takes the pipe's exit status. Redirect to a file, echo `$?`, then read the file.
- **Run TypeScript commands from `apps/web`**, never the repo root. At the root `npx tsc` resolves to an unrelated package and prints "This is not the tsc command you are looking for" while exiting 1.
- **The test command is `node --experimental-test-module-mocks --import tsx --test ...`.** Without that flag `deploy-pipeline.test.ts`'s own `mock.module()` setup throws before any code under test runs, and thirteen tests fail in a way that looks like a regression. This cost a cycle earlier today.

## File structure

| File | Responsibility |
|---|---|
| `apps/web/lib/fleet-place.ts` | `fleetEligibility` and `chooseRuntime` gain one input: whether the checkout has a Dockerfile. |
| `apps/web/test/fleet-place.test.ts` | the refusal's tests grow the case that is currently wrong. |
| `apps/web/lib/deploy-pipeline.ts` | the one `chooseRuntime` call site passes it. |

---

### Task 1: The refusal asks how the app was built, not what its lane is called

**Files:**
- Modify: `apps/web/lib/fleet-place.ts` — `fleetEligibility` (~:82-134) and `chooseRuntime` (~:145-153)
- Modify: `apps/web/test/fleet-place.test.ts`
- Modify: `apps/web/lib/deploy-pipeline.ts` — the single `chooseRuntime` call at ~:2087

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `fleetEligibility` and `chooseRuntime` both take `hasDockerfile: boolean` as a new field on their existing single argument object. Both keep their current return shapes: `Eligibility` (`{ ok: true } | { ok: false, reason: string }`) and `{ runtime: Runtime; reason?: string }`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/fleet-place.test.ts`. Match the file's existing import and helper style — read the top of it first rather than assuming:

```ts
test("a buildpack-lane app that has a Dockerfile is placeable", () => {
  // The lane is fixed before the pipeline writes the SPA and Next.js fallback
  // Dockerfiles, so an app can carry lane "buildpack" and still build a normal
  // image with a resolvable digest. Refusing it reads the label instead of the
  // fact next to it.
  const got = fleetEligibility({
    lane: "buildpack",
    image: "us-central1-docker.pkg.dev/p/r/x@sha256:abc",
    staticServe: false,
    serviceless: false,
    hasDockerfile: true,
  });
  assert.equal(got.ok, true, `refused a real image: ${got.ok ? "" : got.reason}`);
});

test("a buildpack-lane app with no Dockerfile is still refused, and says why", () => {
  // This is the genuine case: `gcloud run deploy --source` builds it and Cloud
  // Run names the result, so at decision time there is no reference to hand a
  // node.
  const got = fleetEligibility({
    lane: "buildpack",
    image: "",
    staticServe: false,
    serviceless: false,
    hasDockerfile: false,
  });
  assert.equal(got.ok, false);
  if (!got.ok) assert.match(got.reason, /buildpack|source/i);
});

test("a Dockerfile does not rescue the lanes refused for other reasons", () => {
  // Each of these is refused for something a Dockerfile does not change: a
  // static app has no image of its own, the runner's image is shared and the
  // app's code is not in it, and a serviceless app publishes no route to probe.
  for (const c of [
    { lane: "static" as const, staticServe: true, serviceless: false },
    { lane: "runner" as const, staticServe: false, serviceless: false },
    { lane: "container" as const, staticServe: false, serviceless: true },
  ]) {
    const got = fleetEligibility({
      lane: c.lane,
      image: "us-central1-docker.pkg.dev/p/r/x@sha256:abc",
      staticServe: c.staticServe,
      serviceless: c.serviceless,
      hasDockerfile: true,
    });
    assert.equal(got.ok, false, `${c.lane} was wrongly allowed by a Dockerfile`);
  }
});

test("no image is still no image, Dockerfile or not", () => {
  // `hasDockerfile` says how it WOULD be built; `image` says what this deploy
  // actually produced. An empty image must still refuse — placing a tag nobody
  // built is the mistake the digest work exists to stop.
  const got = fleetEligibility({
    lane: "container",
    image: "",
    staticServe: false,
    serviceless: false,
    hasDockerfile: true,
  });
  assert.equal(got.ok, false);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts > /tmp/p3a1.txt 2>&1; echo "exit=$?"
cat /tmp/p3a1.txt
```

Expected: a TypeScript error on the unknown `hasDockerfile` property, or the first test failing on the refusal. Either is the right first failure.

- [ ] **Step 3: Add the input and narrow the refusal**

In `apps/web/lib/fleet-place.ts`, add `hasDockerfile: boolean` to `fleetEligibility`'s parameter type and to `chooseRuntime`'s, and have `chooseRuntime` pass it straight through.

Then replace the whole `if (a.lane === "buildpack") { ... }` block with:

```ts
  if (a.lane === "buildpack" && !a.hasDockerfile) {
    // A buildpack image is made BY the deploy: `gcloud run deploy --source`
    // runs the builder and Cloud Run names what comes out, so at decision time
    // there is no reference to hand a node. The fleet has no `--source` of its
    // own to run.
    //
    // Only when there is no Dockerfile, and that qualifier is the whole point.
    // The lane is fixed before the pipeline writes its generated, SPA and
    // Next.js fallback Dockerfiles, so an app can reach here labelled
    // "buildpack" having built a perfectly ordinary image with a resolvable
    // digest. `useDockerBuild` in the pipeline asks this same question at build
    // time; this asks it at decision time, which is when it is needed.
    return { ok: false, reason: "a buildpack image is made by the deploy itself, so there is none to hand a node" };
  }
```

Leave every other refusal exactly as it is. Do not reorder them: `serviceless`, `staticServe` and `runner` are all checked before this and each refuses for a reason a Dockerfile does not change.

- [ ] **Step 4: Pass it from the one call site**

In `apps/web/lib/deploy-pipeline.ts` at ~:2087, the call is:

```ts
    const target = chooseRuntime({ lane, image: processImage ?? "", staticServe: !!staticServe, serviceless });
```

The pipeline computes the same fact later as `useDockerBuild = existsSync(join(dir, "Dockerfile"))` at ~:2381. Compute it here instead, once, and use it in both places so the two cannot drift:

```ts
    // Asked here rather than at build time because the runtime decision needs
    // it and happens first. The generated, SPA and Next.js fallback Dockerfiles
    // are all written above this line, so by now the checkout tells the truth
    // about how this app will actually be built — which its lane label, fixed
    // earlier, no longer does.
    const hasDockerfile = existsSync(join(dir, "Dockerfile"));
    const target = chooseRuntime({ lane, image: processImage ?? "", staticServe: !!staticServe, serviceless, hasDockerfile });
```

Then at ~:2381 replace the second `existsSync` with a reuse:

```ts
    const useDockerBuild = hasDockerfile;
```

If `hasDockerfile` is not in scope at ~:2381 — different function or block — leave the second `existsSync` alone and say so in your report rather than restructuring to force it. Two calls to `existsSync` is a smell; a refactor made to satisfy a plan is worse.

- [ ] **Step 5: Run the tests**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test test/fleet-place.test.ts > /tmp/p3a2.txt 2>&1; echo "exit=$?"
cat /tmp/p3a2.txt
npx tsc --noEmit > /tmp/p3a3.txt 2>&1; echo "tsc exit=$? bytes=$(wc -c < /tmp/p3a3.txt)"
cat /tmp/p3a3.txt
```

Expected: the new tests pass and every pre-existing test in that file still passes. `fleet-place.test.ts` contains assertions about what the fleet refuses and why — if one of them now fails, do not edit it to match. Report it: a pre-existing test changing its answer is either the bug this task is fixing or a case nobody thought about, and both need a human.

- [ ] **Step 6: Run the whole suite**

```bash
cd apps/web && node --experimental-test-module-mocks --import tsx --test 'test/**/*.test.ts' > /tmp/p3a4.txt 2>&1; echo "exit=$?"
grep -E "^# (tests|pass|fail|skipped)" /tmp/p3a4.txt
```

Expected: 0 fail. The baseline before this change is 903 tests, 898 pass, 0 fail, 5 skipped.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/fleet-place.ts apps/web/test/fleet-place.test.ts apps/web/lib/deploy-pipeline.ts
git commit -m "Judge an app by how it was built, not by what its lane is called

fleetEligibility refused every buildpack-lane app because a buildpack image is
named by Cloud Run during the deploy, leaving nothing to hand a node. That is
true only of apps that really take the --source path.

The lane is fixed before the pipeline writes its generated, SPA and Next.js
fallback Dockerfiles, and chooseRuntime runs after all three. So an app can
arrive here labelled buildpack having built an ordinary image with a resolvable
digest, and be turned away by a string that stopped describing it several
hundred lines earlier. The pipeline already asks the right question at build
time as useDockerBuild; this asks it at decision time, which is when the answer
is needed.

Adds no capability and deletes nothing. A set of apps that already produce
exactly what the fleet needs stops being refused."
```

---

### Task 2: Find out how many apps this actually frees

No repository changes. The point of the change is a number, and nobody has it.

- [ ] **Step 1: Count the apps that were refused for this reason**

From the node, where `psql` and a `cloud-sql-proxy` on `127.0.0.1:5432` both exist:

```bash
gcloud secrets versions access latest --secret supersonic-pg-password \
  --project supersonic-deploy-prod > /tmp/pw.txt
gcloud compute scp /tmp/pw.txt fleet-lab-1:/tmp/pw.txt \
  --zone us-central1-a --project supersonic-deploy-prod
rm -f /tmp/pw.txt
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod --command '
  export PGPASSWORD=$(cat /tmp/pw.txt) PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=supersonic_platform
  psql -qtA -F"|" -c "select runtime, count(*) from apps group by runtime"
  psql -qtA -F"|" -c "select lane, count(*) from deploy_stages where lane is not null group by lane order by 2 desc"
  rm -f /tmp/pw.txt'
```

Delete the password file on both ends — the command above does the node side; confirm the local one is gone.

`deploy_stages.lane` records intent per deploy rather than per app, so treat the counts as an indication and say so. There is no lane column on `apps`.

- [ ] **Step 2: Record it**

Put the numbers in the handoff: apps by runtime, and the lane distribution. The claim this task makes is "a set of apps stops being refused", and a claim like that deserves a size.

- [ ] **Step 3: No commit**

---

## Self-Review

**Spec coverage.** The programme spec's phase 3 lists six items. This plan covers exactly one — "stop refusing apps by a string" — and deliberately leaves the other five: teaching the buildpack lane to build, decommissioning the runner per app, reconciling the Cloud Run process set to empty, placing or refusing siblings, and preserving the runtime-version pin. Each is real work with real risk; this one is neither, which is why it goes first.

**Placeholder scan.** None.

**Type consistency.** `hasDockerfile: boolean` is added to both `fleetEligibility` and `chooseRuntime` in Step 3, used in the tests in Step 1, and supplied at the single call site in Step 4. Return shapes are unchanged.

**What this does not do, and must not be read as doing.** It does not make the buildpack lane placeable. An app that genuinely has no Dockerfile is refused exactly as before, with the same sentence. It widens nothing except the accuracy of one question.

**The risk it carries.** If an app reaches `chooseRuntime` with a Dockerfile on disk that the build then does *not* use, this would place it on the fleet with an image that was never built the way the node expects. The guard against that is `image`: `fleetEligibility` still refuses an empty image, and the digest work means a placement carries `IMAGE@sha256:…` resolved from the registry rather than a tag. Step 1's fourth test pins that. It is a guard by construction rather than by check, and it is worth knowing which.
