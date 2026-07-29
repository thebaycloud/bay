# Changelog

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
