# Changelog

## Unreleased

**git decides what gets uploaded, and the CLI says what it left behind.**

Packaging was nineteen `tar --exclude=` patterns plus `--exclude-from=.gitignore`.
tar matches those on basename at any depth, so a module named `src/build/`, a
Composer or `go mod vendor` `app/vendor/`, and a committed `dist/` that *was* the
deliverable were stripped out of the upload — silently, so the first sign of it was
"module not found" three stages later. And tar does not speak gitignore: `!keep.js`
was a literal filename, an anchored `/dist` matched nothing, `**/` meant something
else. `deploy` now runs `git ls-files --cached --others --exclude-standard` and packs
exactly that, so negations, anchors, nested .gitignore files and your global excludes
all work the way `git status` says they do. A folder that is not a repository still
gets the old denylist.

It also prints what it skipped and why — the ignored count with the directories
responsible, and the `.env` files held back to be sent as env vars instead.

**Four things that used to ship broken:**

- files git records as executable but whose working copy lost the bit are named
  before upload, instead of arriving 0644 and exiting "permission denied"
- `.git` goes up when the build reads the version out of it (setuptools-scm,
  hatch-vcs, versioneer), which otherwise publishes `0.0.0` without complaining
- paths that differ only by case are one file on your Mac and two on Linux; you now
  hear about them here rather than from a failing import
- git-lfs pointers are fetched, or the deploy stops and names the files. They are
  130-byte text stubs with `.mp4` names, and every stage after this one reports
  success over them.

## 0.10.0

**`status` can say an app is still coming.**

`ready ? live : down` had no third state, so an app mid-build was reported as
`○ down · revision — · env none` while its build was running normally and its URL
was serving 200. Now `◐ deploying`, with the stage it has reached.

**The live preview stops writing in your folder unannounced.**

It runs your project's dev command in your checkout, and on a fresh one it
installs first — which meant `npm install` in repositories that use bun, pnpm or
yarn, dropping a foreign lockfile into a clean tree two minutes after the command
had already returned. It now uses the package manager your lockfile names, prints
the exact command before running it, and `--no-preview` declines it entirely.

**Everything fixed since 0.9.1 that had never been published.**

Chiefly: `deploy` no longer prints "✓ your app is live at" one second in, before
anything has been built. That was fixed in the repository on 31 July and never
reached anyone, because publishing is something a person has to remember — which
is the actual bug behind this whole section.

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
