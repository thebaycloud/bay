# Supersonic control-plane — the dashboard + API that deploys user apps.
# Needs Node (Next.js + detector), gcloud, and git in one image.

# --- build the Next.js app ---
FROM node:22-slim AS webbuild
WORKDIR /app/apps/web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web ./
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

# --- install the deploy-agent deps (tsx) ---
FROM node:22-slim AS agentdeps
WORKDIR /app/services/deploy-agent
COPY services/deploy-agent/package*.json ./
RUN npm ci
COPY services/deploy-agent ./

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

WORKDIR /app
COPY --from=webbuild /app/apps/web ./apps/web
COPY --from=agentdeps /app/services/deploy-agent ./services/deploy-agent

WORKDIR /app/apps/web
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
