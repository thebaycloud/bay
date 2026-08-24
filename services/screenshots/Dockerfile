# Playwright's own image — it already carries Chromium and every system library the
# browser needs. Installing those by hand on node:slim is a long list that drifts
# with each Chromium release.
#
# This tag and playwright-core's version in package.json must match EXACTLY, and the
# dependency is pinned there rather than ranged for that reason: the image ships the
# browser build its own version expects, and a newer playwright-core looks for a
# browser directory that isn't in the image. A `^1.49.0` range resolved to 1.62.0 and
# the first real screenshot failed with "Executable doesn't exist at
# /ms-playwright/chromium_headless_shell-1234".
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

EXPOSE 8080
CMD ["npm", "run", "start"]
