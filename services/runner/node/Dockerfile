# Node runner base image — built ONCE, shared by every Node app. Build context is
# the runner root (services/runner), so COPY sees entrypoint.sh + the list:
#     docker build -f node/Dockerfile -t <registry>/runner-node:latest .
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar openssl \
 && rm -rf /var/lib/apt/lists/*

# Warm the npm on-disk cache (~/.npm) with the popular packages. We only want the
# cache populated, so the install happens in a throwaway dir whose node_modules is
# discarded — the cached tarballs survive and make a user's --prefer-offline
# install near-instant. `|| true`: a single flaky package must not fail the base.
COPY popular-node.txt /tmp/popular-node.txt
RUN mkdir -p /warm && cd /warm && npm init -y >/dev/null 2>&1 \
 && npm install --no-audit --no-fund $(grep -vE '^#|^[[:space:]]*$' /tmp/popular-node.txt | tr '\n' ' ') || true \
 && rm -rf /warm

COPY entrypoint.sh /usr/local/bin/supersonic-run
COPY prepare.sh /usr/local/bin/supersonic-prepare
RUN chmod +x /usr/local/bin/supersonic-run /usr/local/bin/supersonic-prepare

ENV NODE_ENV=production PORT=8080
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/supersonic-run"]
