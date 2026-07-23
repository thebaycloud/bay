# Supersonic — Build Plan

Phases are **sequence, not scope**. Nothing is cut; this is dependency order. Each phase
ships something demoable and dogfoodable. Marked ⚡ = concentrated risk.

**Cross-cutting tracks** (every phase, never "a phase"): blueprint design system → real
shadcn · multi-tenant security & isolation · cost/observability of our own GCP burn · docs + prompt library.

---

### Phase 0 — Foundations
GCP org/project + Terraform · control-plane API + metadata Postgres · platform auth (Google) ·
Next.js dashboard shell (blueprint) · wildcard DNS + managed SSL for `*.supersonic.cv`.
**Ships:** sign in, see the (empty) cockpit.

### Phase 1 — The deploy spine ⚡ *(make-or-break)*
Ingest doors (local CLI push · GitHub connect · git URL) · cloud deploy-agent (opencode/Gemini)
in a sandbox: clone → detect stack → containerize → Cloud Run → subdomain → live, iterating to green ·
live deploy-log + speed clock.
**Ships:** paste a repo → live in ~40s. Handles stateless apps.

### Phase 2 — Stateful apps (data + secrets)
Polyglot DB detection → provision matching managed DB → inject connection → run migrations ·
secrets/env manager (the one thing we ask the human for) · database browser UI.
**Ships:** real full-stack apps run; data persists.

### Phase 3 — Own the auth + the rest of the batteries
Managed end-user auth (Identity Platform) · file storage + CDN (GCS) · transactional email ·
background jobs + cron. Each with its cockpit service screen.
**Ships:** the "everything's wired" grid is real.

### Phase 4 — Maintenance loop + observability
Central logs · runtime error capture · resident agent → surgical fix-prompt for the user's own
agent (never edits their code) · notifications + push (PWA) · one-tap rollback.
**Ships:** apps stay alive; break one, get a paste-ready fix.

### Phase 5 — Capability layer (distribution)
`supersonic` CLI · MCP server (deploy/fix as actions) · skills/rules generator (Claude Code,
Cursor, AGENTS.md, Copilot) from one source · in-app prompt library · golden path.
**Ships:** deploy from inside any coding agent.

### Phase 6 — Analytics · Security-by-default · Backups
Umami/PostHog auto-embed + view · secret scanning, rate limits, Cloud Armor WAF, auth-guard
suggestions · daily backups + one-tap restore.
**Ships:** every app measured, safe, recoverable by default.

### Phase 7 — Full cockpit + resident agent console
Apps home grid · complete per-service screens · resident-agent chat (change-by-prompt) ·
⌘K palette · speed instrumentation · blueprint → hardened real shadcn components.
**Ships:** the whole flow, polished and fast.

### Phase 8 — Growth surfaces
BYO custom domains · teams + roles · usage metering + billing · LLM gateway · Stripe payments
scaffolding · templates/fork gallery (seeded from real deploys) · mobile PWA.
**Ships:** multi-user, monetizable, viral.

### Phase 9 — Hardening & scale
Multi-tenant isolation + security review · per-app quotas · abuse/DDoS · cost controls on the
burn · autoscaling · canary deploys · DR · SLAs · compliance basics.
**Ships:** holds at scale.

---

**Critical path to first wow:** 0 → 1 → 2 (paste repo → full-stack app live in 40s). Phase 1
holds ~80% of the technical risk — de-risk it before layering 3–9.
