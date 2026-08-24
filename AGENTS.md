# Bay

A deploy platform: a developer points it at a repository or a folder and it runs
their app. The control plane is Next.js in `apps/web`; the fleet agent that runs
users' apps on VMs is Go in `services/fleet/agent`.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `The-Red-Onion/supersonic` — the
tracker kept its old name through the rename; the CODE lives in
`thebaycloud/bay`. Driven
through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name:
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root and `docs/adr/` beside it. See
`docs/agents/domain.md`.
