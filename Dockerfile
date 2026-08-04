# Supersonic control-plane — the dashboard + API that deploys user apps.
# Needs Node (Next.js + detector), gcloud, and git in one image.

# --- build the Next.js app ---
FROM node:22-slim AS webbuild
WORKDIR /app/apps/web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web ./
RUN npm run build

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
RUN gcloud components install beta --quiet >/dev/null

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

WORKDIR /app
COPY --from=webbuild /app/apps/web ./apps/web
COPY --from=agentdeps /app/services/deploy-agent ./services/deploy-agent

WORKDIR /app/apps/web
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
