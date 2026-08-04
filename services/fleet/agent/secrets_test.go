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
