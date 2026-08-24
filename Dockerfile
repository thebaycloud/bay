# Supersonic control-plane — the dashboard + API that deploys user apps.
# Needs Node (Next.js + detector), gcloud, and git in one image.

# --- build the Next.js app ---
FROM node:22-slim AS webbuild
WORKDIR /app/apps/web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web ./

# The brand, at BUILD time — because Next inlines NEXT_PUBLIC_* into the client
# bundle and strips everything else. A Cloud Run env var reaches the server and
# never the browser, so the dashboard's own header would go on saying the old
# name while every server-rendered link used the new one.
#
# THESE DEFAULTS WERE THE RENAME'S BLIND SPOT, and it is worth saying how.
#
# The comment above explains the mechanism correctly and the seam was built for
# exactly this — then the cutover changed the runtime environment, the code
# defaults, and seventy-four literals, and never came here. So `PRODUCT_NAME=Bay`
# on the Cloud Run service reached every server-rendered link while the header
# above it said "Supersonic", because `NEXT_PUBLIC_` is checked FIRST by design
# and a build-time value cannot be overridden by a runtime one. The more correct
# the fallback chain became, the more thoroughly a stale build arg won.
#
# Found by looking at production and reading the shipped bundle, which contained
# `(e="Supersonic","Supersonic").trim()||"Bay"` — the default was right and
# unreachable.
ARG NEXT_PUBLIC_PRODUCT_NAME=Bay
ARG NEXT_PUBLIC_ROOT_DOMAINS=thebay.cloud,supersonic.cv
ENV NEXT_PUBLIC_PRODUCT_NAME=$NEXT_PUBLIC_PRODUCT_NAME
ENV NEXT_PUBLIC_ROOT_DOMAINS=$NEXT_PUBLIC_ROOT_DOMAINS
RUN npm run build
# Drop what only the build needed. This is worth ~70 MB of an image that is
# pulled on the critical path of EVERY deploy — `job-launch` is 116s p50, and it
# is Cloud Run scheduling plus this pull.
#
# `tsx` is deliberately a production dependency and not a build-time one, which
# is what makes this line safe. `scripts/deploy-job.ts` runs as
# `node --import tsx scripts/deploy-job.ts`, so pruning it away would break every
# deploy — the obvious optimisation, applied to a package.json that called tsx a
# devDependency, is an outage. It is in `dependencies` now because that is what
# it is.
RUN npm prune --omit=dev

# --- install the detector's deps (tsx) ---
FROM node:22-slim AS agentdeps
WORKDIR /app/packages/detector
COPY packages/detector/package*.json ./
RUN npm ci
COPY packages/detector ./

# --- runtime: node + gcloud + git ---
FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts --install-dir=/usr/local >/dev/null
ENV PATH="/usr/local/google-cloud-sdk/bin:${PATH}"
# `beta` is needed for `run domain-mappings` (pretty *.supersonic.cv domains) and `builds log`.
RUN gcloud components install beta --quiet >/dev/null \
  # The installer keeps a rollback copy of every component and ships two large
  # tools this image never invokes. Both are pure weight on a layer that is
  # pulled before a deploy can start.
  && rm -rf /usr/local/google-cloud-sdk/.install/.backup \
  && rm -rf /usr/local/google-cloud-sdk/bin/bq /usr/local/google-cloud-sdk/platform/bq \
  && rm -rf /usr/local/google-cloud-sdk/platform/gsutil \
  && find /usr/local/google-cloud-sdk -name '*.pyc' -delete

# The repair engines. DEPLOY_AGENT picks which one drives — codex by default,
# opencode one variable away — so BOTH have to be present in the image or the
# switch is a switch to a missing binary. See docs/CODEX.md.
#
# opencode installs to /root/.opencode/bin; symlinked onto PATH.
RUN curl -fsSL https://opencode.ai/install | bash \
  && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
  && opencode --version

# Codex is an npm package. Pinned: the event stream `lib/agents/codex.ts` parses
# is documented nowhere and was established by recording it
# (apps/web/test/fixtures/codex-*.jsonl). An unpinned upgrade can change that
# shape and the first symptom would be a deploy log that has gone quiet.
RUN npm install -g @openai/codex@0.146.0 \
  && codex --version

# Railpack turns an app directory into a build plan; the plan is then executed by
# the matching BuildKit frontend inside the buildx step (lib/build-config.ts).
#
# PINNED, and the pin is load-bearing in a way the others here are not: the CLI
# writes the plan and the frontend reads it, so they are a pair. `RAILPACK_FRONTEND`
# is deliberately unversioned — pinning the reader without the writer would be
# pinning half of a protocol — which makes THIS the version that decides both.
#
# The musl build is statically linked — verified, `file` reports no interpreter —
# so it runs on this glibc image with nothing installed alongside it. 8.4 MB to
# fetch, 24 MB on disk, against a job image we have just spent effort slimming.
ARG RAILPACK_VERSION=0.36.3
RUN curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin railpack \
  && railpack --version

# buildctl talks to the long-lived BuildKit on the build host. It is the client
# half of infra/buildkit/provision-buildkit.sh: the daemon keeps a warm local
# cache on SSD, and this is what reaches it over mTLS.
#
# Only `bin/buildctl` is taken. The archive also carries buildkitd, runc shims,
# CNI plugins and qemu emulators for six architectures — none of which this
# image runs, and all of which it would otherwise carry into every deploy.
ARG BUILDKIT_VERSION=v0.32.2
RUN curl -fsSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz" \
    | tar -xz -C /usr/local bin/buildctl \
  && buildctl --version

WORKDIR /app
COPY --from=webbuild /app/apps/web ./apps/web
COPY --from=agentdeps /app/packages/detector ./packages/detector

WORKDIR /app/apps/web
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
