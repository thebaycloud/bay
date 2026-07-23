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

WORKDIR /app
COPY --from=webbuild /app/apps/web ./apps/web
COPY --from=agentdeps /app/services/deploy-agent ./services/deploy-agent

WORKDIR /app/apps/web
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
