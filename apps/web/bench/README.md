# bench — deploying ten real repositories through the front door

What it is: ten forked repositories, deployed by the actual `supersonic` CLI
against a real control plane with a real token, timed from the outside, and
recorded one row per deploy. Not unit tests. Nothing is mocked, nothing calls
`runDeploy` directly, and the harness sees exactly what a user sees.

What it is for: telling whether the deploy engine still deploys things, and when
it does not, saying where it broke without anybody opening a log.

## Using it

```bash
cd apps/web
export SUPERSONIC_TOKEN=$(node -p "require(require('os').homedir()+'/.supersonic/config.json').token")

npm run bench -- --batch <name> --concurrency 4     # the run: 10 projects, ~30 min
npm run bench:watch -- --batch <name>               # the live view, in another terminal
npm run bench:report -- --file bench/results/<name>-prod.jsonl
```

`--batch <name>` is required and is how a run is found again later. A name that
already has results is refused rather than appended to, so two runs can never be
silently averaged into one.

Useful flags:

| flag | what it does |
|---|---|
| `--only 2048,broken` | just those projects |
| `--concurrency N` | deploys at once (default 5; the plan's ceiling is 5, and any deploy of your own occupies one) |
| `--dry-run` | prints the lanes and the worst-case wall clock, deploys nothing |
| `--keep` | leaves the apps up instead of deleting them |
| `--target local` | points the same CLI at a control plane on this laptop |

`npm run bench:timing` is the other run: one deploy at a time, cold and warm,
three reps. Hours, and the only run whose durations mean anything on their own —
see "Timings" below.

## Reading a row

Every deploy writes one line of JSON to `bench/results/<batch>-<target>.jsonl`.
The fields worth knowing:

- `outcome` — what happened: `live`, `failed`, `timeout`, `refused`.
- `verdict` — that against what `corpus.json` expected. `pass`/`fail` are scored;
  `platform` (a quota or an IAM error) and `inconclusive` (the harness stopped
  watching while the server was still building) are excluded from every rate,
  because neither says anything about whether we can deploy a repository.
- `serverStage` — the last stage the control plane was in. **Where it broke.**
- `serverLog` — the deploy's own error lines and the repair agent's narration.
  **Why it broke.** The agent reads build output nobody keeps, so its narration
  is often the only surviving account of the cause.
- `reservedMs` / `activatedMs` / `firstOkMs` — when the URL was handed out, when
  the pipeline said live, and when the address actually served the app. The gap
  between the last two is the wait a user sits through after we tick the box.

## Timings

`concurrency` is written onto every row and decides whether a duration may be
compared with another. Above 1, these deploys queue behind one shared Cloud Build
pool and each other's cold starts, so the numbers describe the batch rather than
the deploy. `bench:report` refuses to compute the prod-minus-local subtraction
from contended rows for that reason.

Build and plan caches are keyed by file content, not by app. So a second batch of
the same ten repositories is a set of cold APPS on warm INFRASTRUCTURE, and its
durations are not comparable with the first batch of the day even at
`--concurrency 1`.

## Cleaning up

The harness deletes each app as it finishes. `npm run bench:cleanup -- --batch
<name> --target prod` asks GCP what still exists under the batch's slugs, deletes
it, asks again, and fails loudly on anything still standing — because the delete
path swallows its own failures on purpose, and that is how the last set of
orphans went unnoticed for months.

Note: deleting an app does not currently stop a deploy that is running for it, so
an abandoned deploy holds its row — and one of the owner's five concurrent-deploy
slots — for up to an hour. That is what makes a second batch within the hour
queue at the ceiling.

## The corpus

`corpus.json` — ten repositories, each with a reason it is there, and what to
expect of it. Every one is a fork we own whose default branch `bench` is frozen
at a recorded sha: the pipeline clones with `--depth 1` and no ref, so tracking
an upstream branch would silently change the corpus the first time anybody merged
anything.

Most entries say `expect.outcome: "unknown"`. That is deliberate — a guess written
down before any deploy had been measured would turn the first batch into a
self-graded exam. Those projects are reported and not scored.

`budgetS` is a TIMEOUT, not an expected duration. A budget below the deploy it is
timing does not produce a failure, it produces an `inconclusive` row and an
abandoned deploy that keeps running.
