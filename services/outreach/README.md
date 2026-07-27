# @supersonic/outreach

Backend for the internal LinkedIn outreach tool. Owns prospects, campaign state,
per-account send caps, and (from phase 2) copy generation.

It exists mainly so two things never live in the extension: the Anthropic API
key, and the shared prospect list that stops two teammates working the same
lead. **The LinkedIn session never reaches this service** — all LinkedIn actions
happen in the teammate's own browser tab.

## Setup

Local development, against a plain Postgres — no cloud-sql-proxy needed:

```bash
npm install
createdb supersonic_outreach
export DATABASE_URL="postgres://localhost:5432/supersonic_outreach"
export ALLOWED_ORIGINS="chrome-extension://lkjbbipgcljkefgpefbebjjjjlmoekna"
npm run db:migrate
npm run dev                           # :8081
```

`ALLOWED_ORIGINS` is a comma-separated allowlist; there is no wildcard, because
this service holds the API key and every account token. The ID above is pinned
by the `key` field in the extension's manifest, so it is the same on every
teammate's machine.

Connection resolution, in order:

1. `DATABASE_URL` — verbatim. The local-dev escape hatch.
2. `PG_PASSWORD` and friends — Secret Manager on Cloud Run, over the Cloud SQL
   unix socket.
3. `.pg.json` in the working directory — the shared Cloud SQL instance through
   `cloud-sql-proxy` on 127.0.0.1:5433, same convention as `apps/web`.

Override the database name with `OUTREACH_DB` (default `supersonic_outreach`).

## Issuing a teammate an account

```bash
DATABASE_URL="postgres://localhost:5432/supersonic_outreach" \
  npx tsx scripts/create-account.ts "Arsen" arsen@supersonic.cv Europe/Berlin
```

Prints a `sok_…` token once. Only its SHA-256 hash is stored — losing it means
issuing a new one. Paste it into the extension's Settings tab.

## Endpoints

All except `/health` require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | Liveness, including a Postgres round trip |
| `GET`  | `/me` | Resolve the token to an account |
| `POST` | `/prospects/ingest` | Bulk-upsert a scrape batch |
| `GET`  | `/prospects` | Prospects this account owns |
| `GET`  | `/prospects/stats` | Counts per source, with enrichment progress |
| `GET`  | `/prospects/pending-enrichment` | Next batch of profiles to visit |
| `POST` | `/prospects/:id/enrichment` | Store what the profile page showed |
| `POST` | `/scrape-runs/failed` | Record an aborted scrape (usually a selector miss) |
| `GET`  | `/scrape-runs` | Recent run history |
| `POST` | `/events` | Append to the audit trail |

## Schema notes

- **Prospects are globally unique by canonical profile URL** and owned by exactly
  one account. Ownership is claimed on first insert and never transferred, which
  is what prevents two teammates messaging the same person.
- **`scrape_runs` is the regression alarm.** A run that returns zero looks
  identical to an empty list unless you can see the history, so every run —
  including failures — is recorded.
- **`daily_counters` is written in the same transaction as a send** (phase 3), so
  a crash cannot lose a count and overshoot a cap.
- Migrations are idempotent and re-applied in full on every deploy; there is no
  tracking table. Same convention as `apps/web/db`.

## Status

Phase 1 (sourcing) is complete: ingest, dedupe, ownership, enrichment storage,
run history. Generation, the approval queue, the executor, and reply detection
are phases 2–4.
