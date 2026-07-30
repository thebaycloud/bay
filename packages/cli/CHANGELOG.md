# Changelog

## 0.9.0

**Your `.env` goes up with the deploy.**

An app that reads an API key used to come up crash-looping until somebody noticed and
set the vars by hand. `deploy` now reads `.env` and `.env.local` and sets what the app
needs, so it starts working the first time.

What is deliberately left behind: vars Supersonic sets itself (`DATABASE_URL`, `PORT`,
`STORAGE_BUCKET`), anything whose value points at your own machine, and any key the app
already has — the value you set in production wins over the one in your `.env`, which is
usually a test key. Only names are ever printed, never values. `--no-env` opts out.

**The live preview works on every deploy, not just an app's first.**

The proxy preferred a published build over an open tunnel, so from an app's second
deploy onwards the URL showed the previous release and the preview was never reached.
An open tunnel now wins, for the duration of the build.

Finding the dev server's port no longer depends on it printing a line we recognise —
a server that announces nothing is found anyway, so `--dev-cmd` produces a preview on
stacks where it used to silently produce none.

## 0.7.0

**`deploy` now builds on your machine and uploads only the result.**

Until now the CLI zipped your sources, uploaded them, and the cloud installed the
dependencies and ran the build from nothing — about 80 seconds. Your machine already has
the project and already builds it in under a second, so it does that instead and sends
only the output directory.

Measured on a real Vite project: **26 seconds** for a first deploy, **19 seconds** when
the output changed, and **1-2 seconds** when it did not change at all — the CLI hashes
what it built, asks whether that exact output is already live, and stops if it is.

Applies to projects that build to a directory: Vite, Create React App, Astro without an
SSR adapter, Next.js with `output: 'export'`, and plain static folders. Apps that run a
server still build in the cloud, unchanged — their artifact is an image, not a folder.

Every step falls back rather than failing. A server app, a project the detector cannot
place, a failed install, a failed build, an empty output directory, an unreachable
server: all of them continue to the cloud build exactly as before. `--cloud-build` forces
it.

**`deploy` signs you in by itself.** No separate `supersonic login` step the first time.

**A refused deploy now says why.** A plan limit used to surface as "the build may have
failed or timed out — check supersonic logs", sending you to hunt a failure that never
happened. It now shows what the server actually said.

**`whoami` shows your account email and plan.**

### Notes

The stack detector is now compiled into this package rather than reimplemented in it, so
the CLI and the server always agree about what a project is.

Nothing you were relying on changed shape: `deploy`, `apps`, `status`, `logs`, `errors`,
`env`, `exec`, `rollback` and `diagnose` all behave as before, and `--json` output is
unchanged.
