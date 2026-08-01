# supersonic-cli

Deploy anything to [Supersonic](https://app.supersonic.cv) in one command.

```bash
npm install -g supersonic-cli
```

## Usage

```bash
supersonic init                  # write a DRAFT supersonic.json from this repo
supersonic check                 # what each phase would run, and what would fail
supersonic login                 # authenticate (defaults to app.supersonic.cv)
supersonic deploy                # deploy the current repo (uses your git origin)
supersonic deploy --repo <url>   # or deploy any public git repo
supersonic whoami
supersonic logout
```

`supersonic deploy` streams the live build log — clone → detect stack → build → Cloud Run — and prints your live URL when it's up.

## Before you deploy

`init` and `check` are local. No cloud, no build, no model, about two seconds each,
and they are the loop an agent authoring a `supersonic.json` should be in — because
the same loop through a real deploy is eleven minutes long.

`supersonic init` reads the repository and writes a **draft** `supersonic.json`: the
monorepo split, the install command from the lockfile, the build command and output
directory, the start command bound to `$PORT`, the runtime version the manifests ask
for, and the framework. Then it prints what it could not determine — which service
owns `/`, whether a migration should run before traffic, SPA fallback, which env var
names are secrets — because none of those are answerable from files, and a guess
would be indistinguishable from a decision. It refuses to overwrite an existing
config without `--force`.

`supersonic check` resolves and validates that file exactly as a deploy would, and
prints, per service, the command each phase runs. Non-zero exit on any problem.

Both go through `vendor/resolve.js`, which is `apps/web/lib/{resolve,app-config,
infer-services,repo-facts,lanes,plan-deps}.ts` compiled by
`scripts/bundle-resolver.mjs` — the control plane's own resolver, not a port of it.
Edit any of those and run `npm run bundle`; `test/vendor.test.js` fails on a stale
bundle, which is how a committed detector spent two days answering `python:3.12`
after the runner had moved to 3.14.

## Options

- `supersonic login --url <control-plane>` — point at a different control-plane (defaults to `https://app.supersonic.cv`; also settable via `SUPERSONIC_URL`).
- `supersonic login --email <e>` — skip the email prompt. Password can be piped via `SUPERSONIC_PASSWORD`.

Your session is stored in `~/.supersonic/config.json`.
