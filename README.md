<div align="center">

<img src="apps/landing/public/logo-bay.svg" alt="Bay" width="88" height="88">

# Bay

**Ship anything to a live URL in one command.**

Point Bay at a repo or a folder. It reads the code, works out how to build it,
provisions the database, auth, storage and secrets it needs, and serves it on a
real address — with a live build you can watch while it happens.

[![npm](https://img.shields.io/npm/v/@thebaycloud/cli?label=%40thebaycloud%2Fcli&color=0B5E38)](https://www.npmjs.com/package/@thebaycloud/cli)
[![license](https://img.shields.io/badge/license-AGPL--3.0-0B5E38)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-0B5E38)](https://nodejs.org)
[![deploy](https://github.com/thebaycloud/bay/actions/workflows/deploy.yml/badge.svg)](https://github.com/thebaycloud/bay/actions/workflows/deploy.yml)

[**thebay.cloud**](https://thebay.cloud) · [Templates](https://thebay.cloud/templates) · [Changelog](https://thebay.cloud/changelog) · [Issues](https://github.com/thebaycloud/bay/issues)

```bash
npm install -g @thebaycloud/cli && bay ship
```

</div>

---

## One command, start to finish

<img src=".github/assets/ship.svg" alt="bay ship --wait: uploading, detecting Node, provisioning Postgres, building on the fleet, live URL" width="100%">

<sup>Recorded from a real `bay ship --wait`. Nothing is re-enacted — the app is
[`examples/pgapp`](examples/pgapp), and it is still up.</sup>

## Watch it get built, at its own address

The address answers **before the app does**. Until the app is ready, the URL you
were given serves the build itself — every movement stands for one real line of it.

<img src=".github/assets/room-film.gif" alt="The Room: a harbour scene where a ship is built and launched, the live build log along the bottom and a stage counter" width="100%">

<sup>Frames from one real build, at `m1d9l.thebay.cloud`. The log along the
bottom is that build's own output; the counter is its real stage. Only the owner
sees this — send the link to anyone else and they get a page with no build on it.</sup>

## The database nobody asked for

`examples/pgapp` contains no infrastructure, no Dockerfile and no mention of a
database — just `require("pg")` and a `DATABASE_URL` it expects someone else to
set. Bay reads the dependency, provisions Postgres, isolates it, and injects the
credentials:

<img src=".github/assets/authoring.svg" alt="bay init writes a draft config and names what it could not determine; bay check prints what each phase would run" width="100%">

The result is live right now, and you can open it:

**[xf4u7.thebay.cloud](https://xf4u7.thebay.cloud)**

<img src=".github/assets/live-app.png" alt="The deployed app: pgapp is live, Postgres connected, auto-provisioned DB, visit counter" width="100%">

## Before you ship

`init` and `check` are local — no cloud, no build, no model, about two seconds
each. They are the loop an agent authoring a config should be in, because the
same loop through a real ship is minutes long.

`bay init` reads the repository and writes a **draft** `supersonic.json`, then
prints what it could *not* determine — which service owns `/`, whether a
migration runs before traffic, which env names are secrets — because none of
those are answerable from files, and a guess would be indistinguishable from a
decision.

`bay check` resolves and validates that file exactly as a deploy would, and
prints, per service, the command each phase runs. Non-zero exit on any problem.

## Or hand it to your coding agent

Bay is built to be driven by the thing writing your code, not only by you:

```bash
npx @thebaycloud/cli ship --github --wait
```

Everything the dashboard does, the CLI does — `bay share`, `bay domains`,
`bay db`, `bay logs`, `bay diagnose`, `bay rollback`. Every command takes
`--json`. Run `bay help --all`.

## What you get, without asking for it

| | |
|---|---|
| **Database** | Postgres / MySQL / Mongo / Redis, picked from your ORM |
| **Auth** | end-user auth, owned by your app |
| **Storage** | object storage behind a CDN |
| **Secrets** | the only thing we ever ask you for |
| **Jobs** | `release` before traffic, `worker` and `cron` alongside it |
| **Domains** | `*.thebay.cloud` immediately, your own domain when you point it |
| **Analytics** | who's in the app, embedded |
| **Backups** | daily, with restore |

## Self-hosting other people's software

Bay runs software you didn't write as happily as software you did. The
[templates](https://thebay.cloud/templates) — Excalidraw, Open WebUI, Cal.com —
are prompts rather than buttons: you copy one, your agent reads it, clones the
source and ships it. No form, no dashboard step, since the agent is already
holding everything the deploy needs.

Each template page says up front what gets provisioned, which secrets are
generated for you, and the one or two only you can supply. A one-click deploy
that then demands a Google OAuth client is worse than a page that warned you.

<br>

---

<div align="center"><sub><b>Everything below is how it is built.</b><br>
Nothing above needs it.</sub></div>

---

## How it works

```
        you  ·  your coding agent
                     │  CLI · GitHub push · git URL
                     ▼
              control plane  (apps/web — Next.js + Postgres)
                     │  resolve config → plan the build → provision
                     ▼
        ┌────────────┴────────────┐
        ▼                         ▼
   the fleet                 static apps
   Compute Engine VMs        published to a bucket,
   one gVisor sandbox        served by services/static
   per app, a resident
   agent reconciling
   desired state
        │
        ▼
   load balancer ◄── wildcard DNS + SSL ◄── *.thebay.cloud
```

Nothing pushes to a machine. Each node pulls its desired state, compares it to
what's running, and makes the difference go away. That single loop is the whole
runtime.

Images are built on the fleet's own BuildKit, whose cache is local to the node
and stays warm, and are deployed **by digest** — so "the new version" is a fact
rather than a tag.

## Repository

| Path | What it is |
|---|---|
| `apps/web` | **The control plane.** API, dashboard, build orchestration, billing. Next.js 14 · Postgres · NextAuth |
| `apps/landing` | [thebay.cloud](https://thebay.cloud) — the marketing site, changelog and self-host templates |
| `packages/cli` | `bay` — the CLI on npm ([MIT](packages/cli/LICENSE)) |
| `packages/prompts` | The rules handed to coding agents, one source, copied into each app |
| `services/fleet` | `supersonicd` — the Go agent that runs apps on VMs: reconcile loop, sandboxes, router |
| `services/proxy` | The front door. Decides who may open an app, and serves the Room |
| `services/static` | Serves static apps out of a bucket |
| `services/runner` | Prebuilt Node/Python base images, so a deploy doesn't build a toolchain |
| `services/buildplane` | BuildKit, the machine that turns code into an image |
| `services/shot` | One screenshot per app after it deploys, for the dashboard |
| `services/tunnel` | Local port, public address |
| `services/deploy-agent` | The resident repair agent — scaffolding, not yet wired |
| `infra/terraform`, `infra/bases` | GCP infrastructure and base images as code |
| `examples/` | Small apps used as deploy fixtures, including ones that are broken on purpose |
| `docs/` | [`ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`VM-FLEET.md`](docs/VM-FLEET.md), ADRs |

Two documents are worth reading before you change anything:

- [`CONTEXT.md`](CONTEXT.md) — the vocabulary. There are two languages here,
  platform and product, and they do not mix. A word in the wrong one is a bug.
- [`AGENTS.md`](AGENTS.md) — how agents work in this repo: the issue tracker,
  the triage labels, where domain docs live.

## Local development

```bash
git clone https://github.com/thebaycloud/bay.git && cd bay
```

The control plane talks to two Cloud SQL instances — its own tables on one,
every app's database on the other — so running `apps/web` against real data means
one `cloud-sql-proxy` per instance:

```bash
cloud-sql-proxy -g --port 5433 <project>:<region>:supersonic-platform-pg
cloud-sql-proxy -g --port 5434 <project>:<region>:supersonic-shared-pg
```

```bash
cd apps/web
npm install
npm run dev        # http://localhost:3000
npm test
npm run lint
npm run deadcode   # knip
```

Migrations in `apps/web/db/*.sql` are applied deliberately, never automatically:

```bash
npm run db:migrate
```

> **Careful:** never run the `apps/web` suite under `git bisect run` — the
> fixtures write into the real `.git`.

**No GCP account?** Most of the repo doesn't need one. The CLI, the fleet agent
and the fixtures all build and test on their own:

```bash
cd packages/cli         && npm install && npm test
cd services/fleet/agent && go build ./... && go test ./...
cd apps/landing         && npm install && npm run dev
```

## Contributing

Issues and specs live as [GitHub issues](https://github.com/thebaycloud/bay/issues).
Five triage labels, each meaning exactly its name: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`.

Good first moves: pick something labelled `ready-for-human`, or add an example to
`examples/` for a stack that doesn't deploy cleanly yet — a failing fixture is a
bug report that can't drift.

Before opening a PR, read [`CONTEXT.md`](CONTEXT.md) and match the vocabulary.

## License

[AGPL-3.0](LICENSE), except `packages/cli`, which is [MIT](packages/cli/LICENSE)
so it can be installed anywhere without pulling its licence along.
