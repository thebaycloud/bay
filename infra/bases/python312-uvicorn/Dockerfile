# Base image for hosted Python web apps.
#
# The wheel cache is warmed with the FastAPI/Django/Flask trees. Python's
# equivalent of the npm problem is worse: a project without a wheel for its
# platform compiles from source, so having build-essential present and the common
# wheels already downloaded turns minutes into seconds.
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates build-essential libpq-dev \
  && rm -rf /var/lib/apt/lists/*

# Downloads into pip's cache without installing, so the cache survives and the
# image stays free of packages a customer did not ask for.
RUN pip download --quiet --dest /tmp/warm \
      fastapi uvicorn gunicorn django flask \
      psycopg2-binary sqlalchemy pydantic requests \
  && rm -rf /tmp/warm

WORKDIR /app
