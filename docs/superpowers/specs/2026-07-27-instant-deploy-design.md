# Instant deploys — design

**Goal:** take a static deploy from ~80 seconds to ~15 on a first deploy and ~3 on a
redeploy of unchanged output, by not building at deploy time.

**Status:** approved 2026-07-27. Builds on the three-lane pipeline in
`2026-07-27-fast-deploy-design.md`.

---

## Why the remaining 80 seconds are all in one place

Measured end to end on `github.com/IgorBlink/Cursor-meetup`, from the `deploy_stages`
table this project now keeps:

| Stage | Seconds |
|---|---|
| Clone | reused from detect |
| Detect | 0.8 |
| **Build** | **59.3** |
| Whole deploy | 66.4 |

Ninety percent of a static deploy is `npm install` plus `vite build`. The upload-only
path — same pipeline, no build — measures 13 seconds end to end, six of them the GCS
upload itself. Everything worth winning is in that one stage, and no amount of caching
makes installing and bundling free.

So the design does not try to make the build fast. It moves the build off the critical
path entirely.

## The idea

The person deploying already has the project on their machine, usually with
`node_modules` installed, and runs `vite build` twenty times a day in seconds. Today the
CLI throws that away: it explicitly excludes `dist`, `build`, `out` and `.next` from the
upload and makes the cloud redo the work from nothing.

The CLI builds instead, and uploads only the output.

Two things fall out of that beyond the speed. First, a redeploy whose output is
byte-identical needs no upload at all — just a pointer flip. Second, we stop running
customer `postinstall` scripts on our own infrastructure for this path, which is the
isolation concern that ruled out a shared warm builder in the previous design.

## Scope

**In:** the CLI's folder deploy, for projects the detector calls `static`.

**Out:** container apps — their artifact is an image, not a directory, and we are not
building images on someone else's machine. Also out: the web UI's GitHub path, which
has no local machine; it keeps the cloud build and gets a dependency cache instead
(below).

## Architecture

### One detector, two places

`detectStack(dir)` is already a pure function over a directory. It is compiled to JS and
shipped inside the CLI package, so the CLI and the control plane run **the same
implementation**. A second detector in the CLI would drift within a month, and the
failure would be "the website says Vite, the CLI says Node" — the worst kind, because
both look right in isolation.

### The flow

1. **Detect** locally. No network.
2. **Branch.** `container` → today's path unchanged: upload sources, build in the cloud.
   `static` → continue.
3. **Build.** Install dependencies if `node_modules` is missing, then run the project's
   own build command, streaming its output. A failure here is not fatal — see below.
4. **Hash** the output directory and ask the server whether that hash is already live.
   If it is, stop. Nothing to upload.
5. **Upload** only the output directory, marked as prebuilt, with the hash.
6. **Publish.** The server unpacks into `<slug>/r/<release>/`, verifies, then moves the
   pointer.

### Wire contract

Prebuilt upload reuses the existing upload door with two more headers:

```
POST /api/deploy
  x-supersonic-upload: 1
  x-supersonic-app: <name>
  x-supersonic-prebuilt: 1
  x-supersonic-hash: <sha256>
  Content-Type: application/gzip
  body: tar.gz of the output directory
```

Preflight is a separate, cheap call, because HTTP gives no way to abandon a body once
it is being sent:

```
POST /api/deploy/preflight  { app, hash }  ->  { skip: boolean, url?: string }
```

Both require a session or a CLI token, like every other deploy route.

### The hash

SHA-256 over the output directory: for each file, sorted by relative path, the path
followed by its bytes. Path included so a rename alone changes the hash.

Stored on the app row (`apps.release_hash`), set in the same step that moves the
pointer, so the pointer and the hash can never disagree.

### Verification, before the pointer moves

The agreed safety property, and the reason a bad local build cannot take a site down:

1. `index.html` exists in the uploaded release.
2. Every local `src` and `href` it references exists in the release. Absolute URLs and
   protocol-relative ones are skipped — they are somebody else's problem.
3. Only then is `<slug>/current` written.

This runs against the objects in GCS, **not** through the static server. Letting the
static server address a release other than the live one would create exactly the hole
that lets someone read a private or withdrawn release; checking storage directly catches
everything that actually breaks — an empty directory, a truncated upload, a build that
emitted an index referencing files it never wrote — and adds no new surface.

A failed verification leaves the previous release live and untouched, and reports which
files were missing.

## Error handling

**Local build fails.** Not fatal. The CLI says why, then falls back to today's path:
upload the sources and let the cloud build them, with the repair agent behind it. Someone
whose machine is misconfigured still gets a deploy.

**No build command at all.** The directory already is the site. Upload it directly —
this is the 13-second path that exists today.

**Node major differs** from what the detector inferred for the project: warn, do not
block. It is the single most likely cause of "it built here and broke there", and a
warning at the moment of building is worth more than a support conversation later.

**Preflight unavailable** (older server, network hiccup): treat as "not skippable" and
upload. The optimisation must never be load-bearing.

**Verification fails.** The release stays orphaned in storage, the pointer does not move,
the CLI prints the missing files. Orphans are swept by age.

## The cloud path keeps improving

For the GitHub route, which has no local machine: cache `node_modules` in GCS keyed by
the lockfile hash, restored at the start of the build step and saved at the end. A hit
turns thirty-odd seconds of installing into a few seconds of downloading. This does
nothing for a genuinely first-ever dependency set, which is honest — it is a redeploy
optimisation, and redeploys outnumber first deploys heavily.

The regional npm mirror stays out until its authentication is solved; see
`docs/CUTOVER.md`.

## Testing

Pure functions carry the risk, so they carry the tests: the directory hash (stability,
order-independence, sensitivity to renames), the reference extractor (local versus
absolute, quoting, self-closing tags), and the verifier's decision given a file list.

The CLI's build-and-fallback logic is tested through a seam that reports what it decided
rather than by executing builds.

## Expected results

| Case | Today | Target |
|---|---|---|
| First deploy, static, CLI | 80 s | ~15 s |
| Redeploy, output unchanged | 80 s | ~3 s |
| Redeploy, output changed | 80 s | ~15 s |
| GitHub route, warm dependency cache | 80 s | ~40 s |
| Container app | unchanged | unchanged |

The first three are dominated by the user's own build, which is not our time to spend.
The fourth is a projection; `deploy_stages` will confirm or refute it.
