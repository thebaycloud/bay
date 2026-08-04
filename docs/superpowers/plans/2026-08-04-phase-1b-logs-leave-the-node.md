# Phase 1B: Logs leave the node — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `supersonic logs <slug>` and the dashboard show an app's output whether it runs on Cloud Run or on a fleet node.

**Architecture:** `google-cloud-ops-agent` on the node tails `/srv/apps/*/*.log` into Cloud Logging. The control plane keeps asking Cloud Logging exactly as it does today — one shared filter builder gains an `OR` arm for node logs, and the four call sites above it change not at all. An app mid-migration returns lines from both places.

**Tech Stack:** google-cloud-ops-agent on Ubuntu 24.04; `gcloud logging read`; TypeScript on Node 22 with `node:test` (`apps/web`).

## Why this phase exists

Three times on 2026-08-04 the only way to find out what was wrong was to open an SSH session and read a file: the 256-retry release loop, the cold-boot log-directory bug, and `a8ebb`'s sandbox refusing to start. `getLogs` filters `resource.type=cloud_run_revision`, so for an app on a node `supersonic logs` returns nothing at all — not an error, nothing.

It is also a hard blocker on Phase 4. The commit that deletes the Cloud Run path deletes `getLogs` with it, and without a replacement the dashboard goes blind for every app on the same day.

## What is already true, measured on the node

- **No logging agent is installed.** `google-cloud-ops-agent`, `google-fluentd`, `stackdriver-agent`, `fluent-bit` and `vector` are all absent.
- **The node's service account already holds `roles/logging.logWriter`.** No IAM change is needed. Its other roles are `artifactregistry.writer`, `cloudbuild.builds.builder`, `cloudsql.client`, `iam.serviceAccountUser`, `run.admin`, `storage.admin`.
- **The logs are small.** 980 KB across all twenty apps.
- **They already do not survive a reboot.** Local SSD does not survive a stop; after the 2026-08-04 reboot `/srv/apps/a8ebb` did not exist. Shipping them off the node is what changes that, and it is a gain rather than a mitigation.
- **The files are `/srv/apps/<slug>/<process>.log`** — `app.log` for the implicit web process, otherwise the process name: `beat.log`, `release.log`.

## Global Constraints

- **Never squash commits.** One commit per change.
- **Never print secrets.** Not in logs, not in test output, not in a commit.
- **Every push to `main` deploys the control plane to production.** There is no staging.
- **Never put a pipe inside an `&&` chain that gates a decision** — the chain takes the pipe's exit status. Redirect to a file, echo `$?`, then read the file.
- **Run TypeScript commands from `apps/web`**, never the repo root. At the root `npx tsc` resolves to an unrelated package and prints "This is not the tsc command you are looking for" while exiting 1.
- **The node is reached with `gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod`.** Do not use `/tmp/restart-agent.sh` — it deletes every sandbox and wipes `routes.json`.
- **`pkill -f` inside a `gcloud compute ssh --command` kills the ssh command itself.** Match the exact comm with `-x`, or kill by PID.

## File structure

| File | Responsibility |
|---|---|
| `services/fleet/image/provision.sh` | installs and configures the ops agent, as it does for every other node service. Idempotent, like the rest of the file. |
| `apps/web/lib/log-filter.ts` | **new.** Builds the Cloud Logging filter for one app. The single place that knows an app's lines can be in two resource types. |
| `apps/web/test/log-filter.test.ts` | **new.** Its tests. |
| `apps/web/lib/gcloud.ts` | `getErrors` (~:323) and `getLogs` (~:345) consume the builder instead of writing the filter inline. |
| `apps/web/lib/deploy-pipeline.ts` | `fetchContainerError` (~:231) does the same. |

A separate file for eleven lines of string-building looks disproportionate until you notice there are **three** sites building that filter today and none of them import from each other. The next one will be written by someone who never reads this plan, and the point of the file is that they will find it.

---

### Task 1: The node ships its logs, and we find out what actually arrives

**Files:**
- Modify: `services/fleet/image/provision.sh` — a new section, placed after the cloud-sql-proxy section and before the agent section

**Interfaces:**
- Consumes: nothing.
- **Produces, and Task 2 cannot start without it: the exact, verified filter expression that returns one app's lines and no other app's.** Write it into your report as a single copy-pasteable string. Everything in Task 2 is built on that string being real rather than assumed.

**Do not guess the label shape.** The ops agent's own documentation describes what it attaches to a file-tailed entry, and this plan deliberately does not repeat it, because twice on 2026-08-04 a documented shape and the live shape disagreed — `openssl rand` emitted a trailing newline nobody expected, and a health check that "obviously" probed `/` turned out to probe a reserved path. Install it, send a line through it, and read what comes out the other end.

- [ ] **Step 1: Add the install and config to `provision.sh`**

Insert this section after the `cloud-sql-proxy` unit block and before section 7b (the agent). Match the file's existing idempotent style — every other section checks before acting.

```bash
# ---------------------------------------------------------------------------
# 7a. Log shipping
#
# App stdout and stderr land in /srv/apps/<slug>/<process>.log, written by the
# agent. Without this they stay there: `supersonic logs` filters Cloud Logging
# for cloud_run_revision, so an app on a node produces nothing at all — not an
# error, nothing. Three separate incidents on 2026-08-04 were diagnosable only
# over ssh.
#
# The node's service account already holds roles/logging.logWriter, so there is
# no IAM step here. If entries stop arriving, check that first anyway: it is the
# one dependency this section does not create for itself.
# ---------------------------------------------------------------------------

if ! systemctl list-unit-files | grep -q '^google-cloud-ops-agent'; then
  log "installing google-cloud-ops-agent"
  curl -fsSL -o /tmp/add-google-cloud-ops-agent-repo.sh \
    https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash /tmp/add-google-cloud-ops-agent-repo.sh --also-install
  rm -f /tmp/add-google-cloud-ops-agent-repo.sh
fi

mkdir -p /etc/google-cloud-ops-agent
cat > /etc/google-cloud-ops-agent/config.yaml <<'EOF'
logging:
  receivers:
    supersonic_apps:
      type: files
      include_paths:
        - /srv/apps/*/*.log
    supersonic_agent:
      type: files
      include_paths:
        - /var/log/supersonicd.log
  service:
    pipelines:
      supersonic:
        receivers: [supersonic_apps, supersonic_agent]
EOF

systemctl enable google-cloud-ops-agent
systemctl restart google-cloud-ops-agent
```

The agent's own log is included deliberately. Every incident today was diagnosed
from `/var/log/supersonicd.log` rather than from an app's output, and it is the
file that says *why* an app is not running.

- [ ] **Step 2: Ship it to the node and run it**

```bash
gcloud compute scp services/fleet/image/provision.sh fleet-lab-1:/tmp/ \
  --zone us-central1-a --project supersonic-deploy-prod
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'sudo bash /tmp/provision.sh > /tmp/prov.txt 2>&1; echo "exit=$?"; tail -20 /tmp/prov.txt'
```

`provision.sh` is idempotent and re-running it is the intended way to apply a
change. It ends with `systemctl restart nftables`, so confirm the gate survived
before moving on:

```bash
curl -s -m 10 -o /dev/null -w "health %{http_code}\n" http://8.232.255.172/__fleet/healthz
curl -s -m 10 -o /dev/null -D - -H "x-supersonic-slug: anatf" http://8.232.255.172/ | head -1
```

Expected: `health 200`, and `403` from the second — Phase 0's gate is on and must stay on.

- [ ] **Step 3: Confirm the agent is running and pushing**

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'systemctl is-active google-cloud-ops-agent; sudo journalctl -u google-cloud-ops-agent -n 15 --no-pager | tail -8'
```

Expected: `active`, and no repeated permission or authentication errors. A
`PermissionDenied` here means the service-account claim above is wrong for this
node — stop and report it rather than working around it.

- [ ] **Step 4: Put a known line into a known app's log, then go and find it**

Write a line you can search for unambiguously, into a real app's file:

```bash
gcloud compute ssh fleet-lab-1 --zone us-central1-a --project supersonic-deploy-prod \
  --command 'echo "PHASE1B-PROBE-8842 hello from anatf" | sudo tee -a /srv/apps/anatf/app.log'
```

Then read it back from Cloud Logging, with a filter wide enough that it cannot
miss and narrow enough to be quick:

```bash
gcloud logging read 'textPayload:"PHASE1B-PROBE-8842"' \
  --project supersonic-deploy-prod --limit 3 --freshness 10m --format=json > /tmp/probe.json
echo "exit=$?"
cat /tmp/probe.json
```

Expected: at least one entry. Allow up to a minute — the agent batches.

If nothing arrives, do not proceed and do not invent a filter. Report what
`journalctl -u google-cloud-ops-agent` says.

- [ ] **Step 5: Read the entry and write down the real shape**

From `/tmp/probe.json`, record in your report, verbatim:
- `resource.type`
- every key under `resource.labels`
- every key under `labels`, and the value of whichever one carries the file path
- `logName`

Then build the narrowest filter that returns **only `anatf`'s** lines, and prove
it discriminates by running it twice — once for `anatf`, once for a different
app — and showing the second returns nothing from the first:

```bash
gcloud logging read '<your filter for anatf>' --project supersonic-deploy-prod \
  --limit 5 --freshness 10m --format="value(textPayload)" > /tmp/f-anatf.txt
echo "exit=$?"; wc -l < /tmp/f-anatf.txt
gcloud logging read '<the same filter, slug swapped to bmoj5>' --project supersonic-deploy-prod \
  --limit 5 --freshness 10m --format="value(textPayload)" > /tmp/f-bmoj5.txt
echo "exit=$?"; grep -c "PHASE1B-PROBE-8842" /tmp/f-bmoj5.txt
```

Expected: the first file has lines, the second contains **zero** occurrences of
the probe string. A filter that matches every app is worse than no filter — it
would show one tenant another tenant's output.

**Deliverable for Task 2:** the filter with the slug replaced by the literal
placeholder `SLUG`, written into your report as one line.

- [ ] **Step 6: Commit**

```bash
git add services/fleet/image/provision.sh
git commit -m "The node ships its logs

App output lands in /srv/apps/<slug>/<process>.log and stayed there: getLogs
filters Cloud Logging for cloud_run_revision, so an app on a node produced
nothing at all — not an error, nothing. Three incidents on 2026-08-04 were
diagnosable only over ssh.

The agent's own log ships too. Every one of those incidents was read from
/var/log/supersonicd.log rather than from an app's output; it is the file that
says why an app is not running.

No IAM step: the node's service account already holds roles/logging.logWriter."
```

---

### Task 2: One filter, and the three places that build it stop doing so

**Files:**
- Create: `apps/web/lib/log-filter.ts`
- Create: `apps/web/test/log-filter.test.ts`
- Modify: `apps/web/lib/gcloud.ts` — `getErrors` (~:323) and `getLogs` (~:345)
- Modify: `apps/web/lib/deploy-pipeline.ts` — `fetchContainerError` (~:231)

**Interfaces:**
- Consumes: from Task 1, the verified node-log filter with `SLUG` as the placeholder. **Do not write this task without it.** If Task 1's report does not contain a filter proven to discriminate between two apps, stop and say so.
- Produces: `appLogFilter(slug: string, opts?: { minSeverity?: string }): string` from `apps/web/lib/log-filter.ts`.

Three sites build the same filter today and none imports from the others:
`gcloud.ts:323`, `gcloud.ts:345`, `deploy-pipeline.ts:231`. Adding the node arm
in three places means the fourth site — written later by someone who never reads
this plan — will have the Cloud Run arm only. One builder is the fix.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/log-filter.test.ts`. Replace `<NODE_ARM>` with the arm from
Task 1 before running anything — the assertions below are written against its
shape, not against a guess:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appLogFilter } from "../lib/log-filter";

test("asks both places at once", () => {
  const f = appLogFilter("a8ebb");
  assert.ok(f.includes("cloud_run_revision"), "the Cloud Run arm is missing");
  assert.ok(f.includes("gce_instance"), "the node arm is missing");
  assert.ok(f.includes(" OR "), "the two arms must be alternatives, not a conjunction");
});

test("both arms name the app", () => {
  // An arm that does not name the slug returns every app's output to whoever
  // asked about one — the worst possible failure for this function.
  const f = appLogFilter("a8ebb");
  const arms = f.split(" OR ");
  assert.equal(arms.length, 2, `expected two arms, got ${arms.length}`);
  for (const arm of arms) {
    assert.ok(arm.includes("a8ebb"), `an arm does not name the slug: ${arm}`);
  }
});

test("severity applies to the whole filter, not to one arm", () => {
  // Written as a trailing conjunct outside the parenthesised alternation. If it
  // landed inside one arm, errors from the other runtime would be silently
  // dropped — which is exactly the bug this function exists to prevent.
  const f = appLogFilter("a8ebb", { minSeverity: "ERROR" });
  assert.ok(f.includes("severity>=ERROR"), "severity is missing");
  assert.ok(
    f.trimEnd().endsWith("severity>=ERROR"),
    `severity must be the trailing conjunct, got: ${f}`
  );
});

test("no severity clause when none is asked for", () => {
  assert.ok(!appLogFilter("a8ebb").includes("severity"), "severity leaked in unasked");
});

test("a slug with a dash survives intact", () => {
  const f = appLogFilter("cursor-meetup");
  assert.ok(f.includes("cursor-meetup"), "the slug was mangled");
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd apps/web && node --import tsx --test test/log-filter.test.ts > /tmp/lf1.txt 2>&1; echo "exit=$?"
cat /tmp/lf1.txt
```

Expected: FAIL — cannot find module `../lib/log-filter`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/log-filter.ts`. Substitute Task 1's verified node arm where
marked; everything else is fixed:

```ts
/**
 * Where one app's log lines live, for Cloud Logging.
 *
 * Two places, asked at once. A Cloud Run app writes to `cloud_run_revision`
 * under its service name; an app on a fleet node writes to a file that the ops
 * agent ships under `gce_instance`. An `OR` rather than a branch on
 * `apps.runtime` for two reasons: the callers do not have the runtime and would
 * each have to fetch it, and an app being MIGRATED has lines in both places on
 * the same day — which is precisely when someone is watching.
 *
 * This is one function because three call sites built this string inline and
 * none imported from another. The fourth would have had the Cloud Run arm only.
 *
 * Severity is a trailing conjunct outside the alternation on purpose. Inside an
 * arm it would filter one runtime and not the other, and the failure would look
 * like "the node has no errors" rather than like a bug.
 */
export function appLogFilter(slug: string, opts: { minSeverity?: string } = {}): string {
  const cloudRun = `(resource.type=cloud_run_revision AND resource.labels.service_name=${slug})`;
  // <NODE_ARM> — from Task 1, verified against the live project. Must name the
  // slug, and must not match another app's lines.
  const node = `(<NODE_ARM with SLUG replaced by ${slug}>)`;
  const both = `(${cloudRun} OR ${node})`;
  return opts.minSeverity ? `${both} AND severity>=${opts.minSeverity.toUpperCase()}` : both;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && node --import tsx --test test/log-filter.test.ts > /tmp/lf2.txt 2>&1; echo "exit=$?"
cat /tmp/lf2.txt
```

Expected: 5 passing.

- [ ] **Step 5: Use it at all three sites**

In `apps/web/lib/gcloud.ts`, add `import { appLogFilter } from "./log-filter";`
and replace the two inline filters:

`getErrors` (~:323) becomes:

```ts
  const filter = appLogFilter(slug, { minSeverity: "ERROR" });
```

`getLogs` (~:345) — the `parts` array and its `join(" AND ")` go away entirely:

```ts
  const filter = appLogFilter(slug, opts.severity ? { minSeverity: opts.severity } : {});
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const out = await capture([
    "logging", "read", filter,
    "--project", PROJECT, "--limit", String(limit),
    "--freshness", opts.freshness ?? "1h", "--format=json",
  ]);
```

In `apps/web/lib/deploy-pipeline.ts`, `fetchContainerError` (~:231): add the same
import and replace the inline template string with
`appLogFilter(slug, { minSeverity: "ERROR" })`.

- [ ] **Step 6: Typecheck and run the affected suites**

```bash
cd apps/web && npx tsc --noEmit > /tmp/lf-tsc.txt 2>&1; echo "tsc exit=$? bytes=$(wc -c < /tmp/lf-tsc.txt)"
cat /tmp/lf-tsc.txt
node --import tsx --test test/log-filter.test.ts test/deploy-pipeline.test.ts > /tmp/lf3.txt 2>&1; echo "exit=$?"
tail -12 /tmp/lf3.txt
```

Expected: tsc exit 0 with no output; both suites passing. Run from `apps/web` —
at the repo root `npx tsc` resolves to an unrelated package.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/log-filter.ts apps/web/test/log-filter.test.ts apps/web/lib/gcloud.ts apps/web/lib/deploy-pipeline.ts
git commit -m "One place knows an app's logs can be in two runtimes

getErrors, getLogs and fetchContainerError each built the same
cloud_run_revision filter inline, and none imported from the others. Adding the
node arm three times would have left the fourth site — written later by someone
who never read this — with the Cloud Run arm only, and that site would silently
return nothing for every app on the fleet.

Asked as an OR rather than a branch on apps.runtime: the callers do not have the
runtime, and an app being migrated has lines in both places on the same day,
which is exactly when someone is watching. Severity is a trailing conjunct
outside the alternation, because inside an arm it would filter one runtime and
not the other and look like an absence of errors rather than a bug."
```

---

### Task 3: Prove it through the real path

No repository changes. The proof is that the product works, not that the filter
parses.

**Blocked on:** Tasks 1 and 2, and the control plane carrying Task 2's code —
which means `main` pushed and `.github/workflows/deploy.yml` finished. Confirm
before starting; `--update-secrets`-style config changes do not ship code and
neither does anything else in this task.

- [ ] **Step 1: Confirm the control plane is running this branch**

```bash
gh run list --limit 1 --json status,conclusion,headSha
```

Expected: `completed` / `success`, on the merge commit.

- [ ] **Step 2: Ask the product for a fleet app's logs**

`anatf` runs on the node. Through the dashboard API, with a logged-in session,
or by the CLI if a token is to hand:

```bash
curl -s -m 20 "https://app.supersonic.cv/api/apps/anatf/logs?limit=20" \
  -H "Cookie: <your session cookie>" | head -40
```

Expected: a JSON array of lines with `message`, `time` and `severity`, carrying
`anatf`'s own output — including the `PHASE1B-PROBE-8842` line from Task 1 if it
is still inside the freshness window.

If you cannot obtain a session, say so and use the filter directly with
`gcloud logging read` as a partial check, and mark the product path unverified
rather than claiming it.

- [ ] **Step 3: Confirm a Cloud Run app did not regress**

Pick any app whose `runtime` is `cloudrun` — `landing` is one — and fetch its
logs the same way. This is the check that matters most: the whole change is a
widening of a filter that every Cloud Run app already depends on.

Expected: lines, as before this change.

- [ ] **Step 4: Confirm one app cannot see another's output**

```bash
gcloud logging read '<the Task 2 filter, slug=anatf>' --project supersonic-deploy-prod \
  --limit 50 --freshness 1h --format="value(textPayload)" > /tmp/x-anatf.txt
echo "exit=$?"
grep -c "PHASE1B-PROBE-8842" /tmp/x-anatf.txt
gcloud logging read '<the same filter, slug=bmoj5>' --project supersonic-deploy-prod \
  --limit 50 --freshness 1h --format="value(textPayload)" > /tmp/x-bmoj5.txt
echo "exit=$?"
grep -c "PHASE1B-PROBE-8842" /tmp/x-bmoj5.txt
```

Expected: non-zero for `anatf`, **zero** for `bmoj5`. One tenant reading
another's output is a worse outcome than the blindness this phase set out to fix,
and it is the one failure mode a passing test cannot rule out.

- [ ] **Step 5: Record the numbers**

Put the observed line counts and the two `grep -c` results in the handoff. Note
also how long an entry took to appear after being written — Task 1 Step 4 has
that measurement, and it is what an operator needs to know before concluding
"there are no logs" during an incident.

- [ ] **Step 6: No commit**

Nothing changed in the repository.

---

## Self-Review

**Spec coverage.** The programme spec's phase 1 item "Nothing ships logs off the
node" is covered by Task 1 (shipping) and Task 2 (reading), with Task 3 proving
the product path. The spec also warns that Phase 4 deletes `getLogs` — after
this plan, `getLogs` is a thin wrapper over `appLogFilter`, so the deletion has
one function to preserve rather than three inline strings to notice.

**Deliberately NOT in this plan:**
- **`supersonic logs --follow`.** The CLI polls the same endpoint; nothing here changes polling, and streaming from the node is its own design.
- **Log retention or cost.** Cloud Logging's default retention applies. Twenty apps producing 980 KB total makes this uninteresting today and it should be revisited before a second node.
- **Structured logs.** App output is plain text and stays plain text. Parsing it into `jsonPayload` is a separate change with its own compatibility question.
- **Removing the files from the node.** They stay; the agent tails them. Rotation for `/var/log/supersonicd.log` is a real follow-up — the Phase 1A give-up line writes about 1 MB/day per given-up app, and that now ships too.

**Placeholder scan.** Two remain and both are structural, not laziness:
`<NODE_ARM>` in Task 2 Steps 1 and 3, and the session cookie in Task 3 Step 2.
The first is Task 1's entire deliverable and inventing it here is exactly the
failure this plan is built to avoid; the second is a credential and does not
belong in a document.

**Type consistency.** `appLogFilter(slug: string, opts?: { minSeverity?: string }): string`
is defined in Task 2 Step 3 and used in Step 5 at three call sites and in the
tests in Step 1. `getLogs`'s existing `opts.severity` maps onto `minSeverity`;
`getErrors` and `fetchContainerError` pass `"ERROR"` where they previously
appended `severity>=ERROR` by hand.

**The risk this plan does not remove.** The node arm's precision rests on
whatever label the ops agent attaches, and if that label is the file path, then
an app whose slug is a substring of another's could match both — the same trap
`forgetPrefix` hit in Phase 1A, where `subio` and `subio-2` are both live on this
node today. Task 1 Step 5 and Task 3 Step 4 both test discrimination between two
apps for exactly this reason, and `subio` / `subio-2` is the pair to use if the
filter turns out to be substring-based.
