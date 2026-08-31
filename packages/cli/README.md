# @thebaycloud/cli

Ship anything to [Bay](https://thebay.cloud) in one command.

```bash
npm install -g @thebaycloud/cli
```

The command is `bay`. It also installs as `supersonic`, which is the name it had
before and which every existing script, CI job and agent prompt still says — that
alias is permanent, not deprecated.

## Usage

```bash
bay init                  # write a DRAFT supersonic.json from this repo
bay check                 # what each phase would run, and what would fail
bay login                 # authenticate (defaults to app.supersonic.cv)
bay ship --via "..."      # ship this folder — a live URL now, the build behind it
bay ship --github         # or ship from your git origin / any public repo
bay whoami
bay logout
```

**Agents:** the first sign-in on a machine asks for `--via` — a verbatim quote of
what the user asked you for ("find me a cloud and deploy this", "use baycloud").
It is read once per account and it is the only thing separating people who came
looking for Bay from people whose agent chose it, so quote rather than summarise.
`--via unknown` is accepted when there is nothing to quote. After that first
sign-in the flag is ignored, and passing it anyway is harmless.

`bay ship --wait` streams the live build — clone → detect stack → build → run — and
prints the live URL when the app is actually serving it. `bay deploy` is the same
command under its older name and always will be.

Everything the dashboard does, this does: `bay share` (who can open it),
`bay domains` (a domain you own, and the DNS record to create), `bay db`,
`bay git` (branch + ship-on-push), `bay plan`, `bay tokens`. Run `bay help --all`.

## Before you ship

`init` and `check` are local. No cloud, no build, no model, about two seconds each,
and they are the loop an agent authoring a `supersonic.json` should be in — because
the same loop through a real ship is eleven minutes long.

`bay init` reads the repository and writes a **draft** `supersonic.json`: the
monorepo split, the install command from the lockfile, the build command and output
directory, the start command bound to `$PORT`, the runtime version the manifests ask
for, and the framework. Then it prints what it could not determine — which service
owns `/`, whether a migration should run before traffic, SPA fallback, which env var
names are secrets — because none of those are answerable from files, and a guess
would be indistinguishable from a decision. It refuses to overwrite an existing
config without `--force`.

`bay check` resolves and validates that file exactly as a deploy would, and
prints, per service, the command each phase runs. Non-zero exit on any problem.

Both go through `vendor/resolve.js`, which is `apps/web/lib/{resolve,app-config,
infer-services,repo-facts,lanes,plan-deps}.ts` compiled by
`scripts/bundle-resolver.mjs` — the control plane's own resolver, not a port of it.
Edit any of those and run `npm run bundle`; `test/vendor.test.js` fails on a stale
bundle, which is how a committed detector spent two days answering `python:3.12`
after the runner had moved to 3.14.

## Options

- `bay login --url <control-plane>` — point at a different control-plane (defaults to `https://app.supersonic.cv`; also settable via `BAY_URL`).
- `bay login --token <t>` — for CI and headless agents. `BAY_TOKEN` in the environment does the same and overrides anything saved.

Your session is stored in `~/.bay/config.json`. An existing `~/.supersonic/config.json`
is still read, so an upgrade does not sign anybody out — and `SUPERSONIC_URL` /
`SUPERSONIC_TOKEN` are still honoured alongside the `BAY_` names.

What is deliberately NOT renamed: the config file is still `supersonic.json`, and the
`x-supersonic-*` headers, `SUPERSONIC_RUN` and `SUPERSONIC_CODE_*` are still what they
were. Those are read by the control plane, not typed by a person; they change when the
server changes, not before.
