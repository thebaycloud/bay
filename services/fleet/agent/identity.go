package main

// Proving WHICH node this is.
//
// `FLEET_TOKEN` is one string shared by the whole fleet. It proves membership
// and nothing else: a node that has it can claim to be any other node, and the
// secret broker's per-node placement check is therefore written against a name
// the caller supplies about itself. The broker's own header says so.
//
// A GCE instance identity token is minted by the metadata server for ONE virtual
// machine, signed by Google, and carries that machine's name inside the
// signature. It cannot be copied off this node and used to impersonate another.
//
// WHY THIS NODE CAN MINT ONE. provision.sh drops every packet to the metadata
// server except from uid 0 and 987 — the rule that keeps tenants away from the
// node's credentials. The agent runs as root because it creates network
// namespaces and drives runsc, so it is on the allowed side of it. Measured on
// fleet-lab-1: the identity endpoint answers 000 from a normal shell and 200
// from root.
//
// NOT FATAL WHEN IT FAILS. The shared token still authenticates every call this
// one accompanies. Failing to mint costs the extra proof, not the fleet.

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const defaultIdentityBase = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/identity"

// What we ask Google to mint the token FOR. Must match `NODE_AUDIENCE` in
// apps/web/lib/node-identity.ts — an audience the verifier does not expect is a
// token it refuses.
const nodeAudience = "https://supersonic.cv/fleet"

// A variable so a test can point it at an httptest server, the same seam
// `secretManagerBase` uses and for the same reason. Nothing in production
// assigns to it.
var identityBase = defaultIdentityBase

type identityToken struct {
	token   string
	expires time.Time
}

var (
	identityMu    sync.Mutex
	identityCache identityToken
)

// How long before expiry to mint a fresh one.
//
// Early rather than on expiry: a token that dies in flight is a request the
// control plane refuses for a reason that has nothing to do with this node, and
// the failure would look like an authentication problem rather than a clock.
const identityRefreshBefore = 5 * time.Minute

// The token's own lifetime, as Google issues it. Not parsed out of the JWT —
// that would mean decoding a token this file deliberately never interprets, and
// the value is fixed at an hour.
const identityLifetime = time.Hour

// nodeIdentityToken returns a signed statement of which instance this is.
//
// Cached: the sync loop runs every ten seconds on every node, and a mint per
// request would be a metadata round trip to re-fetch a string good for an hour.
func nodeIdentityToken() (string, error) {
	identityMu.Lock()
	defer identityMu.Unlock()

	if identityCache.token != "" && time.Until(identityCache.expires) > identityRefreshBefore {
		return identityCache.token, nil
	}

	// `format=full` is what puts `google.compute_engine` in the payload, which is
	// the only part that names the machine. Without it the token is still valid,
	// still signed by Google, and proves nothing this file exists to prove.
	u := fmt.Sprintf("%s?audience=%s&format=full", identityBase, url.QueryEscape(nodeAudience))
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")

	c := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext},
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("instance identity: %d %s", resp.StatusCode,
			strings.TrimSpace(string(raw[:min(len(raw), 200)])))
	}

	tok := strings.TrimSpace(string(raw))
	if tok == "" {
		return "", fmt.Errorf("instance identity: empty token")
	}

	identityCache = identityToken{token: tok, expires: time.Now().Add(identityLifetime)}
	return tok, nil
}
