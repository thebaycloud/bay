# Bay

A cloud for small software. Point it at a folder or a repository and it comes back with
an address you can send to somebody — a built image, a running process, a Postgres
database, a certificate, and a URL — without asking you to configure any of it.

Live at **[thebay.cloud](https://thebay.cloud)**. The CLI is
`npm i -g @thebaycloud/cli`, and the command is `bay`.

```bash
bay ship          # publish the folder you are standing in
```

---

## Read this before cloning

**This repository is open to read, not to run.**

Bay is welded to one Google Cloud project. Cloud Run, Cloud SQL, Cloud Build,
Certificate Manager, Artifact Registry, Secret Manager, and Compute instances for the
fleet — not as configuration you could point elsewhere, but as the assumption underneath
the code. There is no `docker compose up`, no local mode, and no seam where another
provider would go.

You can read every line, run the test suites, and follow how the thing is built. You
cannot stand up your own copy without a GCP project, billing, and a day of work that
nobody has written down yet.

That is said here rather than discovered after a clone. If self-hosting matters to you,
[open an issue](https://github.com/thebaycloud/bay/issues) — it is a question of demand,
not of principle.

---

## What is in here

| Path | What it is |
|---|---|
| `apps/web` | The control plane. Next.js: the dashboard, the API, the deploy pipeline, billing, GitHub integration. Everything the platform decides happens here. |
| `apps/landing` | [thebay.cloud](https://thebay.cloud) itself. Also serves `/llms.txt`, the manual coding agents read. |
| `packages/cli` | `@thebaycloud/cli` — the `bay` command. |
| `services/proxy` | The edge. Resolves a hostname to an app, checks who is asking, injects the badge and the owner's toolbar. |
| `services/fleet` | The Go agent that runs on each VM: pulls images, starts processes, routes requests to them. |
| `services/runner` | The scripts baked into every app image — fetch the code, install, build, start. |
| `services/static`, `services/shot` | Static-site serving, and screenshots for thumbnails. |
| `services/deploy-agent` | Reads a repository and works out how to build and run it. |
| `services/buildplane` | Provisions the long-lived BuildKit host that builds go through. |
| `infra/bases` | Base images apps are built on top of. |
| `examples/` | Small apps used as deploy fixtures — a broken one, a Postgres one, a static one. |
| `docs/` | Architecture, decision records, plans, and the research behind them. |

## How this code is written

Worth knowing before reading it, because it is unusual and deliberate.

**Comments explain WHY, at length, and often name the incident that caused the code.**
`lib/source.ts` explains which repository broke a build on 10 August and why the fix
lives where it does. `lib/apps.ts` explains which column, added in which migration, would
have failed every deploy at go-live. These are not decoration — they are the reason the
codebase can be changed safely by somebody who was not there.

**`CONTEXT.md` is the vocabulary.** One glossary, two languages: what the tables and logs
say, and what a person reads. A term in both means the same thing in both. New terms are
added when they are resolved, not in batches.

**`docs/adr/`** holds the decisions that were argued rather than assumed — why a domain
somebody owns is a row the edge looks up, why a GitHub connection is an installation a
workspace owns.

## Working on it

```bash
cd apps/web
npm install
npm test          # 1500+ tests, node:test, no framework
npx tsc --noEmit
```

Every package has its own suite:

```bash
cd packages/cli   && npm test
cd services/proxy && npm test
cd services/fleet/agent && go test ./...
```

One caveat, and it costs an afternoon if nobody tells you:
`apps/web/test/deploy-pipeline.test.ts` **hangs when run alone** and passes as part of
`npm test`. Do not chase it, and do not trust a solo run of that file either.

`npm run dev` starts the dashboard, but most of it needs a database. The platform's
Postgres is reached through a Cloud SQL proxy on port 5433 — which brings you back to
needing the GCP project.

## Status

In production, serving real apps. Small: a handful of apps and users at the time of
writing.

The name changed from Supersonic to Bay on 24 August 2026. `supersonic.cv` still answers
and redirects, `<slug>.supersonic.cv` still serves the apps that were deployed there, and
the old CLI still works — the old names are read everywhere the new ones are written, and
they come out when the people using them have been told, not when the code looks tidy.
