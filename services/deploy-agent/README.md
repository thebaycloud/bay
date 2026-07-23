# deploy-agent

The resident cloud agent — **opencode on Gemini**, running server-side on our GCP credits.
One primitive, three jobs:

1. Cold deploy: clone → detect stack → containerize → provision → iterate to green.
2. Maintenance: watch prod, turn errors into surgical fix-prompts for the user's own agent.
3. Change-by-prompt from the dashboard.

Operates on a **copy** of the repo — never silently commits to the user's source.

**Phases 1–4.** Not yet implemented — scaffolding placeholder.
