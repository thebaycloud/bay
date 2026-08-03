// The one-shot migration, run before traffic moves.
//
// A separate main package on purpose: it is what `release` runs, and it is also
// what makes this repo have TWO main packages — which is the case `go build -o
// /app/server ./...` fails on, and the reason detect.ts picks one.
package main

import (
	"context"
	"log"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	pool, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	_, err = pool.Exec(context.Background(),
		`CREATE TABLE IF NOT EXISTS visits (id bigserial primary key, path text not null, at timestamptz not null default now())`)
	if err != nil {
		log.Fatalf("migrate: %v", err)
	}
	log.Println("migrated")
}
