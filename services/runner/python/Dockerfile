# Python runner base image — built ONCE, shared by every Python app. Build context
# is the runner root (services/runner):
#     docker build -f python/Dockerfile -t <registry>/runner-python:latest .
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar build-essential \
 && rm -rf /var/lib/apt/lists/*

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
