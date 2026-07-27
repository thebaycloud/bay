# outreach-agent

Browser-Use agent that sources LinkedIn prospects into `services/outreach`.

Replaces the extension's hand-written CSS selectors with an LLM that reads the
page. The tasks in `tasks.py` describe the *goal* — "everyone who reacted to
this post" — instead of the DOM path to it, so a LinkedIn markup change no
longer breaks sourcing.

## Setup

```bash
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install -e .
```

## Attach to your real Chrome

The agent drives **your existing browser**, not a fresh one. A new browser
profile on an established LinkedIn account is a device-fingerprint change,
which is among the strongest restriction signals LinkedIn has — so the session,
cookies, and IP all stay yours.

That requires Chrome running with a debugging port:

```bash
./scripts/chrome-debug.sh
```

Then log into LinkedIn in that window if you aren't already.

> **Read this before you run it.** `--remote-debugging-port` lets *any* local
> process drive that browser and read its cookies — for every site, not just
> LinkedIn. `chrome-debug.sh` therefore uses a **separate profile directory**
> (`~/.outreach-chrome`), so the port is only ever exposed to a browser holding
> the one account you log into there. Do not add the flag to your everyday
> Chrome.

## Run

```bash
export OUTREACH_API_URL=http://localhost:8081
export OUTREACH_TOKEN=sok_...            # scripts/create-account.ts in services/outreach
export ANTHROPIC_API_KEY=sk-ant-...

outreach-agent likers      "https://www.linkedin.com/feed/update/urn:li:activity:123/"
outreach-agent commenters  "https://www.linkedin.com/feed/update/urn:li:activity:123/"
outreach-agent search      "https://www.linkedin.com/search/results/people/?keywords=founder"
outreach-agent connections
outreach-agent enrich --batch 10
```

Results post to the same `/prospects/ingest` endpoint the extension uses, so
dedupe, single-owner claim, and run history behave identically regardless of
which path collected the prospect.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OUTREACH_API_URL` | `http://localhost:8081` | The outreach service |
| `OUTREACH_TOKEN` | *(required)* | Per-teammate account token |
| `ANTHROPIC_API_KEY` | *(required)* | Model access |
| `CDP_URL` | `http://localhost:9222` | The Chrome to attach to |
| `OUTREACH_MODEL` | `claude-opus-5` | Model driving the browser |
| `OUTREACH_MAX_STEPS` | `60` | Hard stop on the agent loop |
| `OUTREACH_PAUSE_MIN` / `_MAX` | `1.5` / `4.0` | Seconds between agent steps |
| `ANONYMIZED_TELEMETRY` | `false` | Opted out — task prompts contain prospect data |

## Safety properties

These are the parts worth keeping if the code is ever rewritten.

**The agent is read-only.** `READ_ONLY_CONTRACT` in `browser.py` is prepended to
every task and forbids Connect, Follow, Message, Send, Like, React, Comment,
Share, Endorse, Accept, and form submission. An agent with a real logged-in
session can do anything the human can; the boundary has to be explicit.

**Sending is not, and should not be, done here.** Phase 4 keeps message and
invite sending in the extension, where the action is a deterministic click on
an element a human approved — not a model's choice about which button sends a
message under your name. Read paths tolerate a wrong guess; write paths don't.

**Pacing is enforced between steps**, not left to the model. Browser-Use acts as
fast as the model responds, which is much faster than a person.

**No invented data.** Both output schemas require nulls over guesses. Enrichment
feeds copy generation, so a hallucinated "recent post" becomes a false claim in
a message to a real human.

**Partial pulls are visible.** `PeopleBatch.reached_end_of_list` is reported and
printed. A truncated scrape that reads as complete is how you conclude a source
is exhausted when it isn't.

## Cost

Each agent step is a model call carrying a page summary, so this is meaningfully
more expensive than the selector-based path — think cents per scrape rather than
fractions of one, and slower. That is the trade for not maintaining selectors.
`OUTREACH_MAX_STEPS` is the ceiling on a runaway loop.
