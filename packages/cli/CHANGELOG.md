# Changelog

## 1.1.0

**Everything below `Unreleased` was already written and none of it was shipped.**

`1.0.0` sat in main looking released while npm held a tarball without
`bay share`, without `ship --name`, and without the thebay.cloud rename. The
publish workflow guards on the version field and a no-op publish reports success,
so every push since said "Publish CLI: success" and changed nothing anybody could
install. Its own comment records this happening twice before: "BOTH times the
version sat in main looking released."

Found from the outside, by a deploy report: `bay ship --name` was rejected as an
unknown flag and `bay share <app> public` printed help, both of which the manual
documents and the repository implements. Verified by pulling the published
tarball and diffing `SHIP_FLAGS`.

So this is a version bump and nothing else. What it releases:

- `bay share <app> public|private|shared`, and the whole access surface — add and
  remove people, company rules, pending requests. Implemented, never published.
- `bay ship --name <name>`, so an app is not stuck with a generated slug.
- The rename: `bay` as the command, `thebay.cloud` as the domain, `~/.bay` with
  `~/.supersonic` still honoured.
- `bay logs` as a filter rather than a line count — a level, `source=`, `status=`,
  `path=`, or free text — and `--follow` as a real stream over server-sent events
  instead of polling every 2.5 seconds against a set of every line it had seen.

## Unreleased

**The command is `bay`, and the package is `bay-cli`.**

The product is Bay and the domain is thebay.cloud, so the thing you type is
`bay ship`. Everything about the old name keeps working, and none of it is
deprecated: the package still installs a `supersonic` binary, `~/.supersonic`
is still read when it is the directory that exists, and `SUPERSONIC_TOKEN`,
`SUPERSONIC_URL` and `SUPERSONIC_WHO` are still honoured beside `BAY_TOKEN`,
`BAY_URL` and `BAY_WHO`. A rename that silently stops reading a token file
does not read as a rename — it reads as the platform signing you out — so the
migration is: use the new name if it is there, otherwise keep using theirs.
`lib/home.js` holds that rule and `test/home.test.js` pins it.

Not renamed, deliberately: `supersonic.json`, the `x-supersonic-*` headers,
`SUPERSONIC_RUN`, `SUPERSONIC_CODE_*`, and the encryption salt. Those are read
by the CONTROL PLANE rather than typed by a person, and moving them from this
side would break every ship against a server that has not moved with them.

**Everything the dashboard does, the CLI does.**

`bay share` (visibility, people, and `@company` rules), `bay domains` (attach a
domain you own and print the one DNS record to create), `bay db` (tables, rows,
one read-only SELECT), `bay git` (which branch, and whether a push ships),
`bay plan` (the plan and every limit left) and `bay tokens` (every CLI signed
in to the account, and revoking one). No new endpoints were needed: the control
plane resolves a Bearer token wherever it resolves a session cookie.

The DNS record comes from the server rather than being derived here. Apex versus
subdomain is a public-suffix question, and a second copy of that rule would agree
until the day the list grew — then tell somebody to create a CNAME their
registrar refuses.

**Fixed: `check` claimed every service started from a Dockerfile.**

It printed "start · the Dockerfile's own CMD" for every non-static service,
because it asked whether the lane was `container` — and after the buildpack
lane was removed, `container` means all of them. So a repository with no
Dockerfile, whose start command is stated in the config in plain text, had that
command hidden by the one command whose job is to say what will run. It reads
the author's Dockerfile now.

**Fixed: `open` and `status` knew exactly one domain.**

Both built `https://<app>.supersonic.cv` in the published package — a URL that
survives a rebrand, ignores every attached domain, and can only be corrected by
a release. They ask the API for the app's own address.

## 0.12.1

**A ship now says who is shipping.**

Every deploy request carries `x-supersonic-who`, set from `SUPERSONIC_WHO` and
nothing else — no TTY check, no `CI` check, no guessing. An agent that sets
`SUPERSONIC_WHO=agent` is recorded as one; anything else, including a CI
runner with no terminal at all, is recorded as `someone`. Reporting "agent"
just because there was no TTY would have been a confident lie in the one
field this feature exists to keep honest, so the CLI declares only what it
was told and otherwise says it doesn't know.

## 0.12.0

**`ship` is the word now. `deploy` is an alias and always will be.**

`supersonic ship` is the act of sending your work out — it is what people
say, and it leaves "deploy" to mean the thing sysadmins do. `deploy` keeps
working, unchanged, forever: it is typed by every existing user and written
into every agent prompt and script that already exists, so it is not
deprecated, not warned about, and not going anywhere. `reship` joins
`redeploy` on the same terms.

**A flag `ship` does not understand now stops it.**

It used to be dropped in silence and the deploy went ahead anyway, so a
single typo — `--drt-run` — reserved a slug, uploaded a folder and created
an app nobody asked for. Found by doing exactly that by accident. The cost
lands hardest on agents: a person sees a stray app appear, an agent reads
"deploying — your app will be live at" and reports success for something it
never requested.

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
