# Node runner base image — built ONCE, shared by every Node app. Build context is
# the runner root (services/runner), so COPY sees entrypoint.sh + the list:
#     docker build -f node/Dockerfile -t <registry>/runner-node:latest .
# The active LTS, pinned deliberately.
#
# NOT `:latest` and never an odd-numbered release: those never become LTS, go
# end-of-life within months, and a great many packages simply do not support
# them. A floating tag would also make deploys non-reproducible.
#
# Moving this does not disturb anything already running — Cloud Run pins the
# resolved digest into each revision.
FROM node:24-slim

# python3 + venv + pip for PREPARE time only — the mirror of the node runner's
# reason. A monorepo whose frontend is JS and whose backend is Python has to
# install both in one prepare step, in one image; without this, `backend/` +
# `frontend/` is undeployable whichever lane it lands in. The serving process
# still decides the image, so a Node app that happens to build a Python tool
# prepares here and serves with node alone.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar openssl \
      python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && python3 --version && python3 -m venv --help >/dev/null

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
