# Python runner base image — built ONCE, shared by every Python app. Build context
# is the runner root (services/runner):
#     docker build -f python/Dockerfile -t <registry>/runner-python:latest .
# Pinned deliberately, and bumped deliberately.
#
# NOT `:latest`. A floating base makes a deploy non-reproducible — an app that
# worked yesterday can fail today with no change from its owner — and the
# wheelhouse below is built against whatever this is, so it has to be a version
# the ecosystem has caught up with. 3.14 is that; 3.12 was not enough for repos
# declaring `requires-python = ">=3.14"`, which is now common.
#
# Moving this does not disturb anything already running: Cloud Run resolves the
# tag to a digest at deploy time and revisions are immutable, so a live app keeps
# the image it was deployed with until its next deploy.
FROM python:3.14-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar openssl build-essential \
 && rm -rf /var/lib/apt/lists/*

# Node, for PREPARE time only — not because Python apps need it at runtime.
#
# A monorepo with a Python backend and a JS frontend has to install and build
# both, in one prepare step, in one image. Neither runner could: this one had no
# npm, the node one has no pip, so `backend/` + `frontend/` was undeployable no
# matter what the plan said. The serving process still decides which image runs,
# so a FastAPI app that builds a React frontend prepares here and then serves with
# uvicorn alone.
#
# Copied from the official image rather than installed from apt or NodeSource: it
# is the same binary the node runner uses (no version skew between the two lanes),
# it needs no extra apt index, and it does not drag in a second package manager's
# opinion about /usr/lib.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

# Pre-build a wheelhouse of the popular packages so a user's
# `pip install --find-links=/opt/wheels` resolves offline and fast — this is where
# the heavy scientific wheels (numpy/pandas/pillow) stop dominating cold starts.
# `|| true`: one package that can't wheel must not fail the base build.
COPY popular-python.txt /tmp/popular-python.txt
RUN mkdir -p /opt/wheels \
 && pip wheel -w /opt/wheels -r /tmp/popular-python.txt || true
ENV PIP_WHEELHOUSE=/opt/wheels

COPY entrypoint.sh /usr/local/bin/supersonic-run
COPY prepare.sh /usr/local/bin/supersonic-prepare
RUN chmod +x /usr/local/bin/supersonic-run /usr/local/bin/supersonic-prepare

ENV PORT=8080
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/supersonic-run"]
