# Two agent backends, Codex by default

`lib/opencode-deploy.ts` is 807 lines, exports two functions, and has one caller.
That is the whole surface, and it is why this is a contained change.

Codex becomes the default. opencode stays, behind a switch, because the model and
harness landscape moves faster than we can re-plan around it and the cost of
keeping the door open is one interface.

```
DEPLOY_AGENT=codex      # default
DEPLOY_AGENT=opencode   # the way back
```

## What we actually depend on

```
opencode run --agent {plan|deploy} --model openai/gpt-5.6-sol --auto --format json <prompt>
```

| Concern | opencode | Codex |
|---|---|---|
| invoke | `opencode run <prompt>` | `codex exec <prompt>` |
| agent selection | `--agent plan` + `.opencode/agent/plan.md` | write `AGENTS.md` into the workspace |
| model | `--model <provider>/<id>` | `--model <id>` (global arg on `exec`) |
| no approval prompts | `--auto` | `--sandbox workspace-write` + `-c sandbox_workspace_write.network_access=true` |
| event stream | `--format json` | `--json` |
| provider credentials | `opencode.json` in the workspace | `config.toml` under a per-run `CODEX_HOME` |
| per-run isolation | `XDG_DATA_HOME=<tmp>` | `--ephemeral --ignore-user-config` + per-run `CODEX_HOME` |
| repo without git | — | `--skip-git-repo-check` — **required**, we clone arbitrary repos |
| structured result | prompt the agent to write `plan.json`, else regex JSON out of prose | `--output-schema <file>` |
| final message | accumulate `text` events | `--output-last-message <file>` |

Every row maps. Two rows improve.

## Where the line goes

This is the part a switch changes, and getting it wrong is how you end up
maintaining two of everything.

**A driver's only job is to run a CLI and normalise its event stream.** Nothing
else. Everything that exists because of something we learned the hard way lives
*above* the driver, written once:

- the **redeploy bridge** — `redeploy.sh` POSTs to a local server, the server
  calls the real `redeploy()`, and success is that bridge's `lastUrl`, never the
  agent's prose (`opencode-deploy.ts:800`)
- the **loop detector** — `MAX_CALLS=40`, `REPEATS_ALLOWED=3` (`:520-544`),
  written after a Go repo spent a full 240s budget running `ls -F repo/`
- **`platform.json` / `deploy-plan.json`** — written after an agent burned 287k
  tokens editing a customer's code to work around an IAM grant
- token accounting, the `changes` set, log formatting, `PartialPlan` semantics

If the loop detector ends up implemented twice, the switch has cost more than it
bought. That is the same defect `DEPLOY-PLAN.md` is named after — one rule, two
readers, and only one of them gets fixed.

So the seam is narrow on purpose:

```ts
interface AgentEvent {
  kind: "tool" | "text" | "usage" | "error";
  tool?: { name: string; detail: string; editedPath?: string };
  text?: string;
  usage?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  error?: string;
}

interface AgentBackend {
  /** argv + env + files to seed into the workspace, for one run. */
  spawn(o: RunSpec): ChildProcess;
  /** one line of the backend's stdout → zero or one normalised event */
  parse(line: string): AgentEvent | null;
  /** how this backend returns a schema-shaped result, if it can */
  structuredResult?(ws: string): unknown | null;
}
```

`deploy-pipeline.ts` never learns which backend ran.

## What Codex buys

`--output-schema` takes a JSON Schema and constrains the model's final response
to it. That removes, from the planner:

- the instruction to write the plan to a file path with bash (`:494`)
- `plan.json` as primary read, and the accumulated-prose fallback (`:568-576`)
- `extractPlan` called twice against two different sources

The plan becomes the return value instead of a side effect the agent is asked to
perform and might not. That is the single strongest reason to make Codex the
default.

opencode has no equivalent, so `structuredResult` is optional on the interface
and the write-a-file-then-parse path stays as opencode's implementation of it.
The switch does not drag Codex's win backwards into opencode, and it does not
force opencode's workaround onto Codex.

## The real risks

**1. `gpt-5.6-sol` over the Responses API.** Codex removed `wire_api = "chat"`
outright:

> `` `wire_api = "chat"` is no longer supported. How to fix: set `wire_api = "responses"` ``

If that model is not Responses-capable on our account, Codex cannot be the
default and the switch defaults to opencode instead. **Check first — five
minutes, and it decides the shape of everything below.** This is also the
strongest argument for keeping the switch: that constraint is OpenAI's to change,
not ours.

**2. The event schema is different and undocumented in detail.** opencode emits
`{type: tool_use|text|step_finish|error, part:{…}}`. Codex emits
`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`.
Every log line, every `changes` entry, the token counts and the loop detector
read that stream. It cannot be written from documentation — one probe run,
captured as a fixture, then written against reality.

**3. Network inside the sandbox.** `workspace-write` blocks network by default,
and the repair agent must reach the local bridge on `127.0.0.1` and run `gcloud`.
`-c sandbox_workspace_write.network_access=true` re-enables it. Getting this
wrong looks like an agent that edits files correctly and can never redeploy.

**4. Landlock inside gVisor.** Only if the deploy job moves onto a fleet node:
Codex sandboxes with Landlock, which gVisor does not implement. There the outer
sandbox is the boundary and Codex runs with
`--dangerously-bypass-approvals-and-sandbox`. Not a concern while the deploy job
is a Cloud Run Job.

**5. A switch nobody flips is a switch that is broken when you need it.** The
opencode path will rot silently the first time an event shape changes upstream.
Both backends run against the same recorded fixtures in the test suite, and the
suite fails if either stops satisfying the contract. That is the cost of keeping
the door open, and it is worth paying only if it is actually paid.

## Order

**0. Probe.** One `codex exec --json --output-schema` run against a real repo, in
the control-plane image. Capture the event stream to a fixture; confirm the model
answers. Nothing starts until this returns. — *half a day*

**1. The seam.** Extract `AgentBackend` and lift the bridge, loop detector,
`platform.json` and token accounting out of `opencode-deploy.ts` into a shared
harness. opencode becomes the first implementation, unchanged in behaviour.
`DeployPlan`, `PartialPlan` and `PlatformFacts` move to their own module — they
are the platform's types and were never opencode's. Pure refactor; the suite
should pass untouched. — *1 day*

**2. The Codex backend, planner first.** Smaller of the two, no bridge, and it
gains `--output-schema`. The step-0 fixture is the test. — *1–2 days*

**3. Repair.** Only the spawn and the stream reader are new; everything else was
lifted in step 1. — *1–2 days*

**4. Run both against the same failures.** Identical inputs, both backends,
compare plans and repairs. The apps stuck at `reserved` and the FastAPI monolith
split are real cases with known-correct answers. — *1 day*

**5. Codex becomes the default.** `DEPLOY_AGENT` defaults to `codex`; opencode
stays wired, tested, and one env var away. Nothing is deleted. — *half a day*

Roughly a week. Step 1 is the one that matters: it is what makes step 5 a
one-line change and what stops the switch from doubling the maintenance.

## What this does not fix

Neither backend would have deployed the two apps that prompted this. `zpjsb` died
at dispatch with no `deploy_runs` row — before any agent runs. `z0s7e` died
because `infer-services.ts` split a monolith and the backend went looking for a
frontend directory the split had removed. A better agent harness is worth having;
it is not the fix for either.
