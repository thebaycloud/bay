# Replacing opencode with Codex

`lib/opencode-deploy.ts` is 807 lines, exports two functions, and has one caller.
That is the whole surface, and it is why this is a contained change rather than a
rewrite.

## What we actually depend on

```
opencode run --agent {plan|deploy} --model openai/gpt-5.6-sol --auto --format json <prompt>
```

| Concern | opencode today | Codex |
|---|---|---|
| invoke | `opencode run <prompt>` | `codex exec <prompt>` |
| agent selection | `--agent plan` + `.opencode/agent/plan.md` | write `AGENTS.md` into the workspace |
| model | `--model <provider>/<id>` | `--model <id>` (global arg on `exec`) |
| no approval prompts | `--auto` | `--sandbox workspace-write` + `-c sandbox_workspace_write.network_access=true` |
| event stream | `--format json` | `--json` |
| provider credentials | `opencode.json` written into the workspace | `config.toml` under a per-run `CODEX_HOME` |
| per-run isolation | `XDG_DATA_HOME=<tmp>` | `--ephemeral --ignore-user-config` + per-run `CODEX_HOME` |
| repo without git | — (never mattered) | `--skip-git-repo-check` — **required**, we clone arbitrary repos |
| structured result | prompt the agent to write `plan.json`, else regex JSON out of prose | `--output-schema <file>` |
| final message | accumulate `text` events | `--output-last-message <file>` |

Every row maps. Two rows improve.

## The one thing that must not be lost

`opencodeRepair` does not trust the agent. `redeploy.sh` POSTs to a local bridge,
the bridge calls the real `redeploy()`, and success is `lastUrl` from that bridge
— not the agent's prose (`opencode-deploy.ts:800`). That stays exactly as it is;
it is orthogonal to which CLI runs.

Same for the guardrails that exist because of specific observed failures: the
loop detector (`MAX_CALLS=40`, `REPEATS_ALLOWED=3`, `:520-544`), written after a
Go repo spent a full 240s budget running `ls -F repo/`; and `platform.json` /
`deploy-plan.json`, written after an agent burned 287k tokens editing a
customer's code to work around an IAM grant. Both are prompt-and-harness
concerns, not opencode concerns. They port unchanged.

## What gets deleted

`--output-schema` takes a JSON Schema and constrains the model's final response
to it. That removes, from `planDeploy`:

- the instruction to write the plan to a file path with bash (`:494`)
- `plan.json` as the primary read, and the accumulated-prose fallback (`:568-576`)
- `extractPlan` being called twice against two different sources

The plan becomes the return value instead of a side effect the agent is asked to
perform and might not. That is the single strongest reason to do this.

## The real risks

**1. The event schema is different and undocumented in detail.** opencode emits
`{type: tool_use|text|step_finish|error, part:{…}}`. Codex emits
`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`.
Everything the log line shows the user, every `changes` entry (which files the
agent edited), the token accounting, and the loop detector all read that stream.
This is the bulk of the work and it cannot be written from documentation — one
probe run, schema captured, then written against reality.

**2. `gpt-5.6-sol` over the Responses API.** Codex removed `wire_api = "chat"`
outright:

> `` `wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"` ``

If that model is Responses-capable on our account this is a non-issue. If it is
not, the migration stops here. **Check this first — it is a five-minute test that
can invalidate everything below.**

**3. Network inside the sandbox.** `workspace-write` blocks network by default,
and the repair agent must reach the local bridge on `127.0.0.1` and run `gcloud`.
`-c sandbox_workspace_write.network_access=true` re-enables it. Getting this
wrong looks like an agent that edits files correctly and can never redeploy.

**4. Landlock inside gVisor.** Only if the deploy job ever moves onto a fleet
node: Codex sandboxes with Landlock on Linux, which gVisor does not implement.
There the outer sandbox is the boundary and Codex runs with
`--dangerously-bypass-approvals-and-sandbox`. Not a concern while the deploy job
is a Cloud Run Job.

## Order

**0. Probe.** One `codex exec --json --output-schema` run against a real repo, in
the control-plane image. Capture the event stream to a fixture. Confirm the model
answers. Nothing else starts until this returns. — *half a day*

**1. A seam.** Extract an `Agent` interface — `plan(dir, log)` and
`repair(dir, error, plan, facts, log)` — with the existing opencode
implementation behind it, unchanged. `deploy-pipeline.ts` imports the interface.
Pure refactor, no behaviour change, and it is what lets both exist at once. —
*half a day*

**2. The Codex driver, planner first.** `planDeploy` is the smaller of the two,
has no bridge, and gains `--output-schema`. Behind `DEPLOY_AGENT=codex`. The
event fixture from step 0 becomes the test. — *1–2 days*

**3. Repair.** The bridge, `redeploy.sh`, `platform.json` and the loop detector
port as-is; only the stream reader and the spawn change. — *1–2 days*

**4. Run both against the same failures.** The 4 deploys stuck at `reserved` and
the FastAPI monolith split are real cases with known-correct answers. Compare
plans and repairs on identical inputs before switching the default. — *1 day*

**5. Flip the default, then delete.** `opencode-deploy.ts` goes, along with
`providerConfig`, `buildProviderConfig`, the Vertex base-URL helpers and
`opencodeBin`. `DeployPlan` and `PartialPlan` move to their own module — they are
the platform's types and were never opencode's. — *half a day*

Roughly a week, and steps 1 and 5 are the only ones that touch anything outside
this file.

## What this does not fix

Neither agent would have deployed the two apps that prompted this. `zpjsb` died
at dispatch with no `deploy_runs` row — before any agent runs. `z0s7e` died
because `infer-services.ts` split a monolith and the backend went looking for a
frontend directory the split had removed. A better agent harness is worth having;
it is not the fix for either of those.
