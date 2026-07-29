# tunnel — URL-first, instant-live deploys

Give the user a working URL the instant they hit deploy, not 5–10 minutes later.

```
supersonic deploy → prints https://<slug>.supersonic.cv immediately
                  → that URL is already live: the edge tunnels it to your running
                    dev server, so you can share it / walk away
                  → the real build runs in the background
                  → when it lands, the edge flips the same URL to the built output
```

## Pieces

- **`src/edge.mjs`** — the front door (stands in for `services/proxy`). Resolves the
  slug from `Host`; per slug it is in one of three states: **tunnel** (forward over
  a WebSocket to the CLI's dev server), **holding** (reserved, no tunnel yet → a
  "deploying…" page), or **flipped** (release live → proxy to the shared static
  server). Registration and `/_flip` are token-gated: the edge asks the control
  plane (`/api/apps`) whether the token owns the slug.
- **`src/client.mjs`** — runs on the user's machine (folds into the CLI). Holds the
  WS open and proxies forwarded requests to the local dev server, rewriting `Host`.

## Run locally

```bash
npm install
CONTROL_PLANE_URL=http://127.0.0.1:3000 STATIC_UPSTREAM=<static-run-url> npm run edge
# in the app: npx vite --port 5173
node src/client.mjs <slug> 127.0.0.1:5173 ws://127.0.0.1:7099/_tunnel <token>
curl -H "Host: <slug>.supersonic.cv" http://127.0.0.1:7099/
```

Measured cold (real Vite app, warm node_modules): **~1.3 s to a live URL**, vs a
~90 s server build (or minutes on the client). The build then swaps in with no URL
change.

## To ship in production (remaining)

1. **control-plane**: a `reserve-slug` step so the slug (and `<slug>.supersonic.cv`)
   is returned at the *start* of a deploy — the tunnel and the build must share one
   slug. The `apps` row is already created early; this just returns it first.
2. **CLI**: on `deploy`, print the URL, start/detect the dev server, open the
   tunnel, run the build+publish in the background, then `/_flip`.
3. **edge → proxy**: collapse this into `services/proxy` (it already sits behind
   `*.supersonic.cv` and resolves slug→app), adding the WS tunnel + holding/flip
   states. This is the one step that touches prod DNS/routing (mid-cutover) — do it
   deliberately.
