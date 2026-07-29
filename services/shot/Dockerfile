# Playwright's own image, pinned to the version in package.json — it already
# carries Chromium and every system library the browser needs. Installing those by
# hand on node:slim is a long list that drifts with each Chromium release.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

EXPOSE 8080
CMD ["npm", "run", "start"]
