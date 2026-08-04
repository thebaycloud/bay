package main

import "strings"

// Whose fault a failed start is, decided HERE, on the node.
//
// The control plane cannot work this out. It sees "nothing answered at the load
// balancer" and has historically concluded the app is broken — which dispatches
// an LLM repair agent against the customer's repository, with write access, over
// an outage we caused. The node is the only party that knows whether its own
// Cloud SQL proxy answered, or whether a 403 resolving a secret means its own
// service account is missing an IAM binding rather than the app's spec naming
// something that doesn't exist.
//
// A value rather than a sentence, deliberately. deploy-errors.ts re-derives
// blame by matching substrings and the file documents what that cost: an
// enotfound/ModuleNotFoundError boundary bug that mis-blamed a whole class of
// failures. Classification belongs where the fact is.
type Fault string

const (
	FaultNone    Fault = ""
	FaultNode    Fault = "node"
	FaultApp     Fault = "app"
	FaultUnknown Fault = "unknown"
)

// classifyStartError maps a start failure onto who is responsible.
//
// The default is FaultUnknown and never FaultApp. An error nobody has
// classified is precisely the case where blaming the app is most likely to be
// wrong, and the cost of that mistake is measured in someone's repository.
//
// Matching is on substrings this package's own error producers control, not on
// prose an upstream API chose. dbPathReachable (secrets.go) writes "database
// path" / "not answering" itself. resolveSecret (secrets.go) writes
// "secret %s: %d %s" itself — the status code is ours; the "%s" after it is
// Secret Manager's JSON body and can be reworded in a Google API release
// without anything here breaking loudly, so classification never depends on
// it. A 403 is the node's own service account missing an IAM binding; a 404 is
// the app's spec naming a secret nobody created; anything else (a 500, a
// timeout, a Secret Manager outage) is nobody's fault we can name here, so it
// stays FaultUnknown rather than being guessed into either bucket.
func classifyStartError(err error) Fault {
	if err == nil {
		return FaultNone
	}
	s := strings.ToLower(err.Error())

	switch {
	// The node's own database path. secrets.go names the node in this error.
	case strings.Contains(s, "database path") && strings.Contains(s, "not answering"):
		return FaultNode
	// Resolving a secret: a 403 is our service account, a 404 is the app's spec.
	// Matched on the status code secrets.go itself formats in, not on Secret
	// Manager's message text.
	case strings.Contains(s, "secret ") && strings.Contains(s, ": 403"):
		return FaultNode
	case strings.Contains(s, "secret ") && strings.Contains(s, ": 404"):
		return FaultApp
	default:
		return FaultUnknown
	}
}

// detailLimit bounds what leaves the node. The text lands in a Postgres column
// and, for a node fault, inside a sentence a user reads on a failed deploy.
const detailLimit = 400

// faultDetail is the error text the node is willing to send with a fault.
//
// Only a CLASSIFIED fault carries one, and that restriction is the point rather
// than tidiness. The classified strings are written by this package —
// dbPathReachable's, and resolveSecret's status line plus Secret Manager's error
// body — and contain no app output. An unclassified failure's error can be the
// last 800 bytes of the app's own log, which container.go folds into the runsc
// error: that is the customer's stdout, it can contain anything they printed
// including a credential, and "never print secrets" stops meaning anything the
// moment it is copied off the node into shared Postgres and a user-facing
// message. It stays in the node's log, where it already was.
//
// The count in /status and the fault value itself still travel for an unknown
// fault. Only the prose is withheld.
func faultDetail(f Fault, err error) string {
	if err == nil || (f != FaultNode && f != FaultApp) {
		return ""
	}
	r := []rune(err.Error())
	if len(r) > detailLimit {
		return string(r[:detailLimit]) + "…"
	}
	return string(r)
}
