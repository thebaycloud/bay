# Base image for hosted Next.js and React apps.
#
# Same idea as node22, with the React/Next tree warmed instead. These are the
# heaviest and most universally shared dependencies our customers install, so
# this is where a pre-populated cache pays for itself most.
#
# --ignore-scripts on purpose: we are only warming a cache, and there is no
# reason to execute any package's install hooks while building a base image that
# every tenant's build will then run on top of.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /warm
RUN npm init -y >/dev/null \
  && npm install --no-audit --no-fund --ignore-scripts \
       next@14 react@18 react-dom@18 \
       vite@5 @vitejs/plugin-react@4 \
       typescript@5 tailwindcss@3 postcss@8 autoprefixer@10 \
  && rm -rf /warm/node_modules /warm/package.json /warm/package-lock.json

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
