# @bay/detector

Reads a repository and works out what it is: the language, the framework, the
runtime version, how to install, how to build, how to run it, and whether it
needs a database.

Deterministic — no model, no network, no tokens. The control plane spawns it
during `/api/detect`, and `packages/cli` bundles the same source so
`bay check` answers the question the server would answer rather than a
second opinion that drifts from it.

```bash
tsx src/index.ts <path-or-git-url> [--json] [--dockerfile]
```

## Its name used to promise something else

This directory was `services/deploy-agent`, and its README described "the
resident cloud agent — opencode on Gemini" that would iterate a deploy to green
and turn production errors into fix-prompts. That was a plan from July, marked
"Phases 1–4. Not yet implemented", and it stayed unbuilt while the detector
underneath it became load-bearing.

A directory named after a plan and holding something else sends every reader to
the wrong idea, so it is named after what it does.
