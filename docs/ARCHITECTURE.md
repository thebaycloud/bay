# Bay — Architecture

## The spine

One primitive powers the whole product: **a resident cloud agent** (opencode running on
Gemini, on our GCP credits) that operates on a deployed app server-side. The same agent does:

1. **Cold deploy** — clone any repo → detect stack → containerize → provision → iterate to green.
2. **Maintenance** — watch prod, on error produce a surgical fix-prompt for the user's *own* agent.
3. **Change-by-prompt** — apply requested changes from the dashboard.

## Request flow (deploy)

```
user / their coding agent
        │  (CLI · GitHub · git URL · MCP)
        ▼
  control-plane API ──► deploy-agent (Gemini, sandbox)
        │                     │ detect stack, plan the build (Railpack), fix-to-green
        │                     ▼
        │               a node in the fleet ◄─ load balancer ◄─ *.thebay.cloud (wildcard DNS+SSL)
        │                 (gVisor sandbox, one resident process per declared process)
        │
        │               static apps instead publish to a bucket served by
        │               supersonic-static — see ADR 0001, which keeps them there
        ▼
  provisioners (auto, inferred from the code):
    • DB        → Cloud SQL / AlloyDB / Mongo / Redis (polyglot, by ORM)
    • Auth      → Identity Platform (we own end-user auth)
    • Storage   → GCS + CDN
    • Email     → transactional (deliverability)
    • Jobs      → processes in the app's own spec, run by the node (release before
                  the app starts; cron on the node's scheduler)
    • Secrets   → Secret Manager   (only human-supplied input)
    • Security  → secret scan · rate limit · Cloud Armor WAF
    • Analytics → Umami / PostHog (embedded)
    • Backups   → daily + restore
```

## Principles

- **Horizontal for the user, constrained under the hood** — we guide the *agent* toward
  reliably-provisionable patterns; we never constrain the *human*.
- **Every capability is one-click AND prompt-driven** — dashboard button + copy-a-prompt.
- **We're not a host — we're the backend + front door.** Data, users, and secrets live with
  us; switching cost compounds.
- **Burn freely** — abundant GCP credits (incl. Gemini). Speed and magic beat cost.

## Stack

Next.js · React · TypeScript · Tailwind · shadcn/ui · Geist / Geist Mono / Instrument Serif ·
"blueprint" design system. GCP everywhere. Cloud agent = opencode + Gemini.
