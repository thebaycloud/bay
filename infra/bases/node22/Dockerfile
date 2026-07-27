# Base image for hosted Node apps.
#
# Two jobs. First, living in our own regional Artifact Registry removes a Docker
# Hub pull — and its rate limit — from every customer build. Second, the npm cache
# below is pre-populated, so a first deploy of a project we have never seen finds
# most of its dependency tree already on disk and never opens a socket for it.
#
# That second job is the point: Kaniko's layer cache keys on the lockfile hash,
# which is worth nothing the first time we see a project. Caching what projects
# have in *common* is what makes a cold deploy fast.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Warm the npm cache with the packages nearly every Node project pulls in. The
# install itself is thrown away; only /root/.npm survives into the image.
WORKDIR /warm
RUN npm init -y >/dev/null \
  && npm install --no-audit --no-fund --ignore-scripts \
       express@4 dotenv@16 zod@3 cors@2 \
  && rm -rf /warm/node_modules /warm/package.json /warm/package-lock.json

WORKDIR /app
