# goapi

A real Go service, used to test a claim rather than to demonstrate one.

Postgres via pgx, a migration that runs once before traffic, and TWO main
packages — `cmd/server` and `cmd/migrate` — because that is what a Go service
looks like the moment it has migrations, and because `go build -o /app/server
./...` fails on exactly that shape.

Before the routing collapse the platform could not deploy this at all: the runner
holds one Node image and one Python image, and a second service in any other
language was refused outright.
