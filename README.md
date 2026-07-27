# Supersonic

**Deploy anything in one click.** Point us at the app you vibe-coded — we turn it into a
real, live product (database, auth, email, storage, everything) on `*.supersonic.cv` in
seconds. No infra, ever. As easy as posting a story.

> The only thing we ever ask you for is a secret that's yours alone — never code, never config.

## Monorepo layout

| Path | What it is | Phase |
|------|------------|-------|
| `apps/web` | The dashboard / cockpit — Next.js + shadcn, "blueprint" design system | 0, 7 |
| `services/control-plane` | Core API: apps, deploys, provisioned resources, billing | 0 |
| `services/deploy-agent` | The resident cloud agent (opencode on Gemini): ingest → detect → provision → iterate-to-green → maintain | 1–4 |
| `packages/cli` | `supersonic deploy` — the pro speed lane | 5 |
| `packages/mcp` | MCP server exposing deploy/fix as agent actions | 5 |
| `packages/skills` | One source → Claude Code skill, Cursor rules, AGENTS.md, Copilot instructions | 5 |
| `infra/terraform` | GCP infra as code (Cloud Run, Cloud SQL, Identity Platform, DNS, SSL…) | 0 |
| `docs/` | `PHASES.md` (full build plan), `ARCHITECTURE.md` | — |
| `apps/outreach-extension` | Internal growth tool: MV3 extension for LinkedIn outreach | — |
| `services/outreach` | Backend for the above — prospects, campaigns, caps, copy generation | — |

> `apps/outreach-extension` and `services/outreach` are internal sales tooling,
> not part of the product. They ship on their own cadence.

## Status

**Phase 0 in progress.** `apps/web` runs the blueprint cockpit locally.

```bash
cd apps/web
npm install
npm run dev      # http://localhost:3000
```

See [`docs/PHASES.md`](docs/PHASES.md) for the full 10-phase plan.
