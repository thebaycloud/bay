package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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

// secretManagerError returns the error resolveSecret really produces for a
// given Secret Manager response, by CALLING resolveSecret against a stand-in
// server rather than mirroring its format string.
//
// The distinction is the whole point of the fixture. A mirrored copy of
// "secret %s: %d %s" proves only that the mirror matches itself: reword
// secrets.go and these tests stay green while classifyStartError quietly
// returns FaultUnknown for every real secret failure, and a node fault goes
// back to being blamed on the app. Calling the producer means rewording it
// fails a test here instead.
//
// The two seams it borrows (secretManagerBase, tokenSource) are package
// variables, so this is not safe under t.Parallel() — no test in this package
// uses it, and the restore is registered before the first assignment.
func secretManagerError(t *testing.T, name string, status int, body string) error {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)

	prevBase, prevToken := secretManagerBase, tokenSource
	t.Cleanup(func() { secretManagerBase, tokenSource = prevBase, prevToken })
	secretManagerBase = srv.URL
	tokenSource = func() (string, error) { return "not-a-real-token", nil }

	v, err := resolveSecret("example-project", name)
	if err == nil {
		t.Fatalf("expected an error from a %d response, got a value of %d bytes", status, len(v))
	}
	return err
}

func TestAMissingSecretIsTheNodesFaultWhenItIsAPermissionProblem(t *testing.T) {
	// A 403 resolving a secret is the node's service account, not the app's
	// spec. The body text mirrors Secret Manager's real wording, but the
	// classifier must not depend on it — only the "403" resolveSecret's own
	// %d writes is load-bearing here.
	err := secretManagerError(t, "app-foo-DATABASE_URL", 403,
		`{"error":{"code":403,"message":"Permission denied on resource project app-foo.","status":"PERMISSION_DENIED"}}`)
	if got := classifyStartError(err); got != FaultNode {
		t.Fatalf("got %q, want %q", got, FaultNode)
	}
}

func TestAMissingSecretIsTheAppsFaultWhenItDoesNotExist(t *testing.T) {
	// A 404 is the spec naming a secret nobody created — that IS the app.
	err := secretManagerError(t, "app-foo-DATABASE_URL", 404,
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
	err := secretManagerError(t, "app-foo-DATABASE_URL", 500,
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
