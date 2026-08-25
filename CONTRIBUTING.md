# Contributing

**We take contributions as human-written text, not code.**

Describe the change you would like, informally, in a `.txt` or `.md` file in
[`adrs/`](adrs/) — open a pull request that adds only that file. If we are
aligned on it, we handle the implementation.

That is not a formality and it is not a filter on the quality of your writing.
This repository is a platform that runs other people's code: a change to the
deploy pipeline, the edge proxy, or the fleet agent lands on live tenant
applications minutes after it merges. Reviewing a patch against that requires
holding the whole system in mind, and a well-meant patch that is 80% right costs
more to review than it saves. A paragraph describing what you want costs us
nothing to read and tells us the thing we actually need to know.

So the shape is:

1. **A proposal in `adrs/`.** What is wrong or missing, what you would like
   instead, and — if you know — where in the tree it lives. Prose is fine.
   Bullet points are fine. One paragraph is fine.
2. **We answer in the pull request.** Either we are aligned and we build it, or
   we explain why not. "Why not" is a real answer here, not a soft no.
3. **We implement it.** You get credit in the commit and in the release notes.

## Reporting a bug

That is what [issues](https://github.com/thebaycloud/bay/issues) are for, and no
`adrs/` file is needed. What helps most: what you ran, what you expected, what
happened, and the app slug or deploy id if it was on `thebay.cloud` — that is the
handle that finds the logs.

## Vulnerabilities

**Privately, never in a public issue.** See [SECURITY.md](SECURITY.md) — GitHub's
private advisory reporting is enabled on this repository, and there is an email
address there if it fails.

## If you send code anyway

We will read it, and we may well agree with it, but the default outcome is that
we close it and implement the idea ourselves from the description. Please do not
take that as rudeness — it is the same rule applied evenly, and the rule exists
because of what this code runs, not because of who wrote the patch.

Two exceptions, where a patch is genuinely easier for us than a paragraph:
typos and factual errors in documentation, and anything in `examples/`.

## What you can do without asking anybody

Read it. The repository documents its own architecture in `docs/` and its
vocabulary in `CONTEXT.md`, and both are written to be read by somebody who does
not work here. `README.md` explains why you cannot stand up your own copy yet;
if that is what you want, say so in an issue — it is a question of demand, not
of principle.

You can also run the test suites, which need no cloud project and no
credentials:

```bash
cd apps/web        && npm ci && npm test   # the control plane
cd services/proxy  && npm ci && npm test   # the edge
cd services/static && npm ci && npm test
cd packages/cli    && npm ci && npm test   # the bay command
cd packages/detector && npm ci && npm test
cd services/fleet/agent && go test ./...   # the node agent
```

## Licence

This repository is **AGPL-3.0-only**, with one deliberate exception:
`packages/cli` is **MIT**, because it is client software that runs inside other
people's projects. See [`LICENSE`](LICENSE) and
[`packages/cli/LICENSE`](packages/cli/LICENSE).

By opening a pull request — including one that adds a file to `adrs/` — you
agree that what you contribute may be used under those licences.

## Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). It is the Contributor Covenant, and
the address for anything that needs one is `founders@thebay.cloud`.
