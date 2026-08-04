package main

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// TestAnUnreachableDatabaseProxyIsTheNodesFault does not hand-write
// dbPathReachable's message. It calls the real function (a port nothing
// listens on refuses the connection immediately — the same fixture
// secrets_test.go already uses), so this test exercises the exact string
// production will produce and breaks here if that wording ever changes,
// instead of silently degrading the classifier to FaultUnknown.
func TestAnUnreachableDatabaseProxyIsTheNodesFault(t *testing.T) {
	err := dbPathReachable("127.0.0.1:1", 200*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error for a port nothing listens on")
	}
	if got := classifyStartError(err); got != FaultNode {
		t.Fatalf("got %q, want %q — a dead node proxy must not be blamed on the app (err: %v)", got, FaultNode, err)
	}
}

// secretManagerError mirrors the fmt.Errorf in resolveSecret (secrets.go:70)
// exactly — "secret %s: %d %s" — rather than a hand-typed finished string. It
// is a copy of that format, not a call to resolveSecret itself: resolveSecret
// reaches the real metadata server and Secret Manager API, which a hermetic
// unit test cannot do without network access this package doesn't expose a
// seam for. Mirroring the format string is the next best thing to calling it;
// if secrets.go:70 is ever reworded, this comment is the reminder to update
// the mirror, and until it is, a passing test here does NOT prove the
// production string still matches.
func secretManagerError(name string, status int, body string) error {
	return fmt.Errorf("secret %s: %d %s", name, status, body)
}

func TestAMissingSecretIsTheNodesFaultWhenItIsAPermissionProblem(t *testing.T) {
	// A 403 resolving a secret is the node's service account, not the app's
	// spec. The body text mirrors Secret Manager's real wording, but the
	// classifier must not depend on it — only the "403" resolveSecret's own
	// %d writes is load-bearing here.
	err := secretManagerError("app-foo-DATABASE_URL", 403,
		`{"error":{"code":403,"message":"Permission denied on resource project app-foo.","status":"PERMISSION_DENIED"}}`)
	if got := classifyStartError(err); got != FaultNode {
		t.Fatalf("got %q, want %q", got, FaultNode)
	}
}

func TestAMissingSecretIsTheAppsFaultWhenItDoesNotExist(t *testing.T) {
	// A 404 is the spec naming a secret nobody created — that IS the app.
	err := secretManagerError("app-foo-DATABASE_URL", 404,
		`{"error":{"code":404,"message":"Secret [projects/x/secrets/app-foo-DATABASE_URL] not found or has no versions.","status":"NOT_FOUND"}}`)
	if got := classifyStartError(err); got != FaultApp {
		t.Fatalf("got %q, want %q", got, FaultApp)
	}
}

func TestASecretManagerOutageIsUnknownNotEitherBucket(t *testing.T) {
	// A 500 from Secret Manager is neither our service account nor the app's
	// spec — it is a third party having a bad day. Lumping it into either
	// bucket would misdirect an ops page or a repair agent at the wrong owner,
	// so it must fall through to unknown like anything else unrecognised.
	err := secretManagerError("app-foo-DATABASE_URL", 500,
		`{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}`)
	if got := classifyStartError(err); got != FaultUnknown {
		t.Fatalf("got %q, want %q", got, FaultUnknown)
	}
}

func TestAnUnrecognisedErrorIsUnknownNotApp(t *testing.T) {
	// The default must not be "app". Defaulting to the app is what dispatches a
	// repair agent against a customer's repository over our own outage, and an
	// error nobody has classified is exactly the case where that is most likely
	// to be wrong.
	err := errors.New("something nobody has seen before")
	if got := classifyStartError(err); got != FaultUnknown {
		t.Fatalf("got %q, want %q — an unclassified error must not read as the app's fault", got, FaultUnknown)
	}
}

func TestNoErrorIsNoFault(t *testing.T) {
	if got := classifyStartError(nil); got != FaultNone {
		t.Fatalf("got %q, want %q", got, FaultNone)
	}
}
