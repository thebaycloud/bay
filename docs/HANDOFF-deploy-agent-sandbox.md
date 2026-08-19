# Handoff — the repair agent cannot run anything (gen1 vs bubblewrap)

Written 19 Aug 2026. Read this before touching `scripts/setup-deploy-worker.sh`,
the `deploy-worker` step in `cloudbuild.yaml`, or `apps/web/lib/agents/codex.ts`.

**One line:** `supersonic-deploy-worker` runs on Cloud Run **gen1**, deploys go to
it, and Codex sandboxes itself with bubblewrap, which gen1 cannot support — so
every command the planner and the repair agent run fails before it starts.

The fix is one flag. It is already applied to the other two services that run
Codex. The worker was added later and never got it.

---

## 1. What it looks like

Two real deploys of `github.com/onlytenders/2048-in-react` on 19 Aug, both dead.
Grep the deploy log for any of these:

```
planner · bash exited 1: bwrap: loopback: Failed RTM_NEWADDR: No child process
agent: ERROR codex_core::tools::router: error=apply_patch verification failed:
         Failed to read file to update /tmp/ss-repair-XXXX/repo/next.config.js
agent: ERROR codex_core::tools::router: error=exec_command failed for
         `/bin/bash -lc 'bash redeploy.sh'`: CreateProcess { message: "Rejected…" }
WARNING: proceeding, even though we could not create PATH aliases:
         Refusing to create helper binaries under temporary dir "/tmp"
```

The tell is that **every** command fails, including trivial ones. In the first
run the planner managed `find`, `rg --files` and `pwd` — all three `exited 1`
with the same `bwrap` line. An agent whose `pwd` does not work is not a bad
agent; it has no shell.

Note the agent **diagnosed the app correctly both times** ("only disable Next's
image optimization, leave `output:'export'` alone"). It could not write the file
or start the rebuild. The repair logic is not what is broken.

---

## 2. Why

`apps/web/lib/agents/codex.ts:87` runs Codex with:

```js
"--sandbox", "workspace-write",
```

On Linux that sandbox is bubblewrap. Bwrap creates a network namespace and
brings up `lo` inside it. **gen1 is gVisor**, which does not provide the
namespaces bwrap needs, so the netlink call comes back
`RTM_NEWADDR: No child process` and nothing executes.

### The call chain, all of it tracked code

```
supersonic-deploy-worker           ← Cloud Run service, gen1
  scripts/deploy-worker.ts
  apps/web/lib/deploy-one.ts       deployOne
  apps/web/lib/deploy-pipeline.ts  runDeploy
  apps/web/lib/agents/index.ts     planDeploy / agentRepair
  apps/web/lib/agents/codex.ts     codex exec --sandbox workspace-write
  bubblewrap                       ✗
```

The worker runs the **same image** as the control plane, just with a third
command (`--command node --args=--import,tsx,scripts/deploy-worker.ts`), so it
carries the whole pipeline — planner and repair agent included.

### This is already documented in the repo

`cloudbuild.yaml`, on the `supersonic-control-plane` deploy step:

> gen2, because chat runs Codex and Codex sandboxes itself with bubblewrap.
> On gen1 every command the agent ran died with `bwrap: loopback: Failed
> RTM_NEWADDR: No child process` — bubblewrap could not create its network
> namespace, so nothing executed: not the tools, not even a `sed` on a file in
> its own workspace.
> gen2 runs a real kernel with the namespaces bubblewrap needs. **This is the fix
> that KEEPS the sandbox**: the alternative is `--sandbox danger-full-access`,
> which would hand the agent's shell the network back […]

### Why it drifted

Three services run Codex. The flag is set in three unrelated places, by hand:

| service | execution environment | set where |
|---|---|---|
| `supersonic-control-plane` | **gen2** | `cloudbuild.yaml`, the `deploy` step |
| `supersonic-deploy-job` | **gen2** | on the live job (survives `jobs update`) |
| `supersonic-deploy-worker` | **gen1 (default)** | **nowhere** |

Neither place that creates or updates the worker passes it:

- `scripts/setup-deploy-worker.sh:108` — `gcloud run deploy` with no
  `--execution-environment`
- `cloudbuild.yaml`, `id: deploy-worker` — updates only `--image` and env vars

The worker was added after gen2 was adopted, and the flag did not travel.

---

## 3. How this was established

Do not take it on trust; these are the commands.

```bash
# Which services are on which execution environment
gcloud run services list --project=supersonic-deploy-prod --region=us-central1 --format=json \
| python3 -c "
import json,sys
for s in json.load(sys.stdin):
    ann=s['spec']['template']['metadata'].get('annotations',{})
    print(s['metadata']['name'], ann.get('run.googleapis.com/execution-environment','gen1 (default)'))"

# The job is fine
gcloud run jobs describe supersonic-deploy-job --region=us-central1 \
  --project=supersonic-deploy-prod --format=json | grep execution-environment

# Which resource handled the failed deploys (slugs wfmd9, sr65b)
gcloud logging read '("wfmd9" OR "sr65b") AND timestamp>="2026-08-19T17:20:00Z"' \
  --project=supersonic-deploy-prod --limit=30 \
  --format="value(resource.labels.service_name)" | sort | uniq -c
#   → supersonic-deploy-worker (and the proxy). Zero from the job.

# The job executions in that window were only the CI smoke test
gcloud run jobs executions list --job=supersonic-deploy-job --region=us-central1 \
  --project=supersonic-deploy-prod --limit=6
# then read one:
#   "deploy-job: run ci-smoke-not-a-real-run is not on file — nothing to do"
```

Also worth knowing: the control plane's lane flags say which executor is live.

```bash
gcloud run services describe supersonic-control-plane --region=us-central1 \
  --project=supersonic-deploy-prod --format=json | grep -A1 DEPLOY_WORKER_URL
# PLANNER=1  RUNNER=0  DEPLOY_JOB=1  DEPLOY_WORKER_URL=https://supersonic-deploy-worker-…
```

The worker is the fast path; the Job is the fallback for when the worker refuses
(busy, wrong commit, unreachable). So in the ordinary case the agent runs on the
broken one.

---

## 4. The plan

### Step 1 — unbreak production now

```bash
gcloud run services update supersonic-deploy-worker \
  --region=us-central1 --project=supersonic-deploy-prod \
  --execution-environment=gen2
```

This is cheap here. gen2's real cost is a slower cold start, and the worker runs
`--min-instances 1 --max-instances 1`, i.e. permanently warm. It has 4Gi (gen2
needs ≥512Mi) and gen2 supports the direct VPC egress the worker already uses.

**Do not** "fix" this with `--sandbox danger-full-access` in `codex.ts`. That
gives the agent's shell the network back, and no-network is the entire reason a
prompt injected through an app's own database rows cannot leave with anything.
See the note in `cloudbuild.yaml` and `lib/chat/bridge.ts`.

### Step 2 — verify it actually worked

Deploy the corpus case that is *supposed* to fail and be repaired:

```bash
cd $(mktemp -d)
supersonic ship --github --repo https://github.com/onlytenders/2048-in-react --wait
```

(Use the repo CLI — `node packages/cli/index.js` — the published `supersonic-cli`
is 0.10.0 and has neither `ship` nor `delete`.)

From `apps/web/bench/corpus.json`, key `2048`: `expectLane: static`,
`expect.outcome: live`. It fails on `next/image` under `output:'export'` and the
repair agent is meant to fix it by disabling image optimization.

What to look for:
- no `bwrap` lines at all;
- the planner's `find` / `rg` commands returning output instead of `exited 1`;
- `apply_patch` succeeding;
- `redeploy.sh` actually starting.

Clean up after: `node packages/cli/index.js delete <slug> --yes`.

### Step 3 — make it stick

Add `--execution-environment=gen2` in both places, or the flag is one service
recreation away from being lost again:

- `scripts/setup-deploy-worker.sh`, the `gcloud run deploy "$WORKER"` call
- `cloudbuild.yaml`, `id: deploy-worker`, the `gcloud run deploy` line

Put the *reason* next to it, the way the control-plane step does — a bare flag
gets deleted by the next person tidying up.

### Step 4 — an invariant, so it cannot drift a third time

"Everything that runs Codex is gen2" is currently held in three unrelated places
by memory. Worth a guard. Cheapest honest version: a test that reads
`cloudbuild.yaml` and `scripts/setup-deploy-*.sh` and asserts every deploy of a
service running the agent image passes `--execution-environment=gen2`. A live
check in the deploy workflow's smoke step would also work and would catch manual
drift, which the source-reading test cannot.

---

## 5. Secondary, and NOT established

```
Refusing to create helper binaries under temporary dir "/tmp"
(codex_home: AbsolutePathBuf("/tmp/ss-codex-…"))
```

`apps/web/lib/agents/codex.ts:42` sets

```js
h = mkdtempSync(join(tmpdir(), "ss-codex-"));   // → /tmp/ss-codex-XXXX
```

and recent Codex refuses to create its PATH-alias helper binaries when
`CODEX_HOME` is under `/tmp`. It is a warning — the run proceeds — but
`apply_patch` is exactly the kind of thing that ships as such a helper, and we
saw `apply_patch verification failed` three times.

**This is a hypothesis.** On gen1 nothing worked anyway, so it could not be
separated. Re-check it after Step 1. If `apply_patch` still fails on gen2, move
`CODEX_HOME` off `/tmp` — `/var/tmp/ss-codex-*` or a dedicated directory baked
into the image — and keep the per-run isolation the comment there asks for
(concurrent deploys must not share auth or session state).

---

## 6. State at the time of writing

- `main` is at `b3eed74`; control plane deployed from it and verified live.
- No test apps left: `supersonic apps` → empty. `sqqgi`, `z5f34`, `wfmd9`,
  `sr65b` were all created and deleted during this session.
- Uncommitted in the working tree, unrelated to this and still waiting:
  - `packages/cli` vendor/resolver repair — 105/106, needs `npm run bundle` in
    `packages/cli` to refresh the stamp. It fixes a `main` that is already broken
    (`resolver.entry.ts` imports `isServiceless` from a deleted `process-plan.ts`).
  - Four dead files from an abandoned extraction, safe to delete —
    `apps/web/lib/deploy-execute.ts`, `apps/web/lib/deploy-worker-server.ts`,
    `apps/web/test/deploy-dispatch.test.ts`, `apps/web/test/deploy-worker.test.ts`.
    `apps/web/test/stages.test.ts:48` records that this extraction "was never
    made".
- Known cosmetic issues in the room's new log box, none of them this bug:
  a yard lamp's bloom lands on the text (needs a scrim), consecutive identical
  lines are not collapsed (six `building…` in a six-line box), and raw Codex
  stderr (`agent: …ISO timestamp… ERROR codex_core::…`) is shown alongside the
  agent's actual speech (`agent · …`).
