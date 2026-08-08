# Changelog

## 0.11.0

**`--dev-cmd`, `--dev-port` and `--no-preview` are gone, and the link they were
for is better without them.**

Those flags ran your app locally and tunnelled your public URL to it while the
real build ran, so the address showed something instead of a placeholder. What
the address shows now is the room: the build itself, drawn, live, at the app's
own URL — for you and for anyone you send the link to. It needs nothing running
on your machine, works the same for every stack, and turns into the app the
moment it first answers.

Passing the removed flags is now an unknown-flag error rather than a silent
no-op, so a script still passing them says so instead of quietly changing
behaviour.

One thing the tunnel got wrong goes with it. A redeploy flips an app back to
"deploying", and an open tunnel outranked the published build for that whole
window — visitors to a working app were sent to a laptop mid-edit. A landed
build is now served whatever the status says.

## 0.10.1

**`env set` and `env unset` stop announcing a rollout that is not happening.**

Both printed "— new revision rolling out", unconditionally and on both runtimes.
An app on a node has no revisions, and the line went out even for a write that
changed nothing — which is how the command read as a success while `env` went on
listing the key you had just removed. The server now says what it actually did:
"the node applies this within about ten seconds", or the new revision on Cloud
Run. The CLI repeats that instead of guessing.

What was genuinely broken is on the server, and is already fixed for 0.10.0 as
well: anything that came from your `.env` is stored as a secret, and these two
commands only ever edited the plain variables sitting beside it. Upgrading does
not fix that and staying does not break it — this release only stops the CLI
describing it wrongly.

## 0.10.0

**`supersonic init` and `supersonic check` — the deploy loop, on your machine, in
two seconds.**

The loop for getting a `supersonic.json` right ran through a real deploy: upload,
provision, build, fail, read a log, guess. Eleven minutes an attempt, and eleven
attempts is two hours and a Cloud Build bill for every one of them. Both new
commands are local — no cloud, no build, no model.

`init` writes a **draft**, and says so. It reads what the files actually state: the
monorepo split, the install command from the lockfile, the build command and output
directory, the start command bound to `$PORT`, the runtime version from
`engines.node` / `.nvmrc` / `requires-python` / `.python-version`, the database from
a dependency scan, the framework, and every env var name a `process.env` /
`os.environ` grep can see. Then it prints what no static analysis can answer —
which service owns `/` when both are servers, whether `alembic upgrade head` should
run before traffic or is merely installed, whether a committed `dist/` is the
deliverable or stale, SPA-fallback intent, and which of those env var names are
secrets.

The detector doing the reading is the same one that read a `frontend/` + `backend/`
root as "Static site, 80% confidence" — its own highest-confidence answer, and
wrong. Nothing here makes it better. What changes is that its answer now lands in a
file, in front of the agent that wrote the app, instead of silently selecting a lane
on a server 200 seconds later. Never ask an agent to author JSON from nothing; ask
it to correct a draft.

`check` is that file resolved and validated exactly as a deploy would, printing per
service the command each phase runs — install, build, release, start, health, scale
— and exiting non-zero on any problem. It catches a static service that declared a
migration, a build with nowhere to publish from, two services claiming one path, a
directory that is not there, and a `requires-python` the runner does not have.

Both go through the control plane's own resolver, compiled into `vendor/resolve.js`
rather than ported. A second implementation would agree the day it was written and
diverge the first time a lane changed, and "check passes, the deploy resolves
differently" is indistinguishable from the platform being broken. `npm run bundle`
rebuilds it and a test fails a stale one — which caught the vendored detector still
answering `python:3.12` two days after the runner moved to 3.14, a number that
decided the `FROM python:…-slim` of every containerised Python build.

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
