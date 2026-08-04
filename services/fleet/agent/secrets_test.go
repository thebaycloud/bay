package main

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestDBPathReachableReportsTheNodeNotTheApp(t *testing.T) {
	// A listener that exists is enough: this asks "is the database path up on
	// this node", not "is Postgres healthy".
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	if err := dbPathReachable(ln.Addr().String(), time.Second); err != nil {
		t.Fatalf("a live listener should be reachable: %v", err)
	}
}

func TestDBPathUnreachableNamesTheNode(t *testing.T) {
	// The message is the whole point. An app that cannot reach the database is
	// indistinguishable from an app that is broken, and the repair agent will
	// go and edit a customer's repository over our outage.
	err := dbPathReachable("127.0.0.1:1", 200*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error for a port nothing listens on")
	}
	if !strings.Contains(err.Error(), "node") {
		t.Fatalf("the error must blame the node, got: %v", err)
	}
}

func TestHasDatabaseIgnoresAnAppsOwnExternalDatabase(t *testing.T) {
	// Bring-your-own-database apps set DATABASE_URL themselves, pointing at
	// Supabase, Neon, or anywhere else. Gating their start on this node's
	// Cloud SQL proxy would be wrong twice over: they never touch that proxy,
	// and a dead proxy would block a start that would otherwise have worked.
	app := App{Env: map[string]string{"DATABASE_URL": "postgresql://user:pass@db.example-project.supabase.co:5432/postgres"}}
	if hasDatabase(app) {
		t.Fatal("an app's own external DATABASE_URL must not gate on our proxy")
	}
}

func TestHasDatabaseCatchesThePlatformProxyInEnv(t *testing.T) {
	// The platform writes the resolved DATABASE_URL secret into Env pointing at
	// this node's proxy — that is the one case Env alone should gate on.
	app := App{Env: map[string]string{"DATABASE_URL": "postgresql://user:pass@" + dbProxyAddr + "/db"}}
	if !hasDatabase(app) {
		t.Fatal("an Env DATABASE_URL naming the proxy address must gate")
	}
}

func TestHasDatabaseCatchesTheUnresolvedSecretReference(t *testing.T) {
	// Before resolution the reference lives in Secrets, not Env, and its mere
	// presence there means the platform — not the app — provisioned it,
	// regardless of what Env happens to hold.
	app := App{Secrets: map[string]string{"DATABASE_URL": "app-example-DATABASE_URL"}}
	if !hasDatabase(app) {
		t.Fatal("a Secrets DATABASE_URL entry must gate")
	}
}

func TestHasDatabaseFalseWithNeither(t *testing.T) {
	app := App{}
	if hasDatabase(app) {
		t.Fatal("an app with no DATABASE_URL anywhere must not gate")
	}
}

func TestHasDatabasePlatformSecretWinsOverUnrelatedEnv(t *testing.T) {
	// An app can plausibly carry both: a platform-provisioned Secrets entry
	// (this app has our database) alongside an Env DATABASE_URL that is stale,
	// hand-set, or otherwise unrelated. The Secrets entry is the platform's own
	// record of what it provisioned, so it must win — an app that really does
	// have our database must not be let off the gate by a confusing Env value.
	app := App{
		Secrets: map[string]string{"DATABASE_URL": "app-example-DATABASE_URL"},
		Env:     map[string]string{"DATABASE_URL": "postgresql://user:pass@db.example-project.supabase.co:5432/postgres"},
	}
	if !hasDatabase(app) {
		t.Fatal("a platform Secrets entry must gate even when Env names something else")
	}
}
