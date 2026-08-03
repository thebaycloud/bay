// A real Go service: Postgres-backed, migrated on boot, serving JSON.
//
// It exists to test a claim rather than to be a demo. Before the collapse the
// platform could not deploy this at all: the runner has a Node image and a Python
// image because someone built two Dockerfiles, and `deploySibling` refused
// anything that was not one of those two languages outright.
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type app struct{ db *pgxpool.Pool }

func (a *app) handle(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if _, err := a.db.Exec(ctx, `INSERT INTO visits (path) VALUES ($1)`, r.URL.Path); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	var n int64
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM visits`).Scan(&n); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("content-type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok": true, "language": "go", "runtime": os.Getenv("GO_VERSION"), "visits": n,
	})
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	a := &app{db: pool}
	http.HandleFunc("/", a.handle)
	log.Printf("listening on %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
