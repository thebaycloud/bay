package main

import "testing"

// A placement is written before anything is placed, so a sidecar's address does
// not exist when the spec is made. The spec carries `${process:name}` and the
// node fills it in — which also means a process that restarts into another slot
// leaves no stale address behind in somebody else's environment.

func appWithCache() App {
	return App{
		Slug:  "a",
		Image: "registry/a@sha256:aaa",
		Processes: []Process{
			{Name: "web", Kind: KindWeb},
			{Name: "redis", Kind: KindWorker, Image: "docker.io/library/redis:7-alpine"},
		},
		ProcessIPs: map[string]string{"redis": "10.200.1.9"},
	}
}

func TestProcessAddressIsSubstituted(t *testing.T) {
	got := resolveProcessAddrs("redis://${process:redis}:6379", appWithCache(), Process{Name: "web", Kind: KindWeb})
	if got != "redis://10.200.1.9:6379" {
		t.Errorf("got %q", got)
	}
}

func TestEveryOccurrenceIsSubstituted(t *testing.T) {
	// Four spellings of the same endpoint go into an app's environment, and a
	// single-shot replace would fix one of them.
	got := resolveProcessAddrs("${process:redis}:6379 and ${process:redis}", appWithCache(), Process{Name: "web"})
	if got != "10.200.1.9:6379 and 10.200.1.9" {
		t.Errorf("got %q", got)
	}
}

func TestAnUnstartedSidecarLeavesThePlaceholder(t *testing.T) {
	// Substituting an empty string would hand the app `redis://:6379`, which
	// fails somewhere deep inside a client library. Leaving the placeholder makes
	// the value obviously unresolved in the app's OWN error message.
	app := appWithCache()
	app.ProcessIPs = nil
	got := resolveProcessAddrs("redis://${process:redis}:6379", app, Process{Name: "web"})
	if got != "redis://${process:redis}:6379" {
		t.Errorf("an absent address should stay visible: got %q", got)
	}
}

func TestAProcessCannotResolveItself(t *testing.T) {
	// It would be its own address, which is never what the placeholder is for and
	// would quietly hide a spec that names the wrong process.
	app := appWithCache()
	app.ProcessIPs = map[string]string{"redis": "10.200.1.9"}
	got := resolveProcessAddrs("${process:redis}", app, Process{Name: "redis", Kind: KindWorker})
	if got != "${process:redis}" {
		t.Errorf("got %q", got)
	}
}

func TestAnUnknownProcessNameIsLeftAlone(t *testing.T) {
	got := resolveProcessAddrs("${process:nosuch}", appWithCache(), Process{Name: "web"})
	if got != "${process:nosuch}" {
		t.Errorf("got %q", got)
	}
}

func TestOrdinaryValuesAreUntouched(t *testing.T) {
	// The syntax must not collide with a shell expansion an app legitimately
	// ships in its own environment.
	for _, v := range []string{"plain", "$HOME/x", "${NOT_A_PROCESS}", "${process:}", "100%"} {
		if got := resolveProcessAddrs(v, appWithCache(), Process{Name: "web"}); got != v {
			t.Errorf("%q became %q", v, got)
		}
	}
}

// A process that needs a sibling's ADDRESS has to wait for it. The substitution
// happens once, at start, from what is live at that moment — so a process that
// starts first gets `${process:redis}` verbatim and hands it to a DNS lookup.
// Measured on a live deploy: `getaddrinfo ENOTFOUND ${process:redis}`. Client
// retry does not save it, because the value it was given never changes.

func agentWith(live map[string]*live) *Agent {
	return &Agent{live: live, quiet: newLogThrottle()}
}

func TestWaitsForASidecarThatIsNotUpYet(t *testing.T) {
	app := appWithCache()
	app.Processes[0].Env = map[string]string{"REDIS_URL": "redis://${process:redis}:6379"}
	a := agentWith(map[string]*live{})

	if got := a.waitingOn(app, app.Processes[0]); got != "redis" {
		t.Errorf("should wait for redis, got %q", got)
	}
}

func TestStopsWaitingOnceTheSidecarIsLive(t *testing.T) {
	app := appWithCache()
	app.Processes[0].Env = map[string]string{"REDIS_URL": "redis://${process:redis}:6379"}
	a := agentWith(map[string]*live{
		sandboxID(app.Slug, Process{Name: "redis"}): {net: &SandboxNet{}},
	})

	if got := a.waitingOn(app, app.Processes[0]); got != "" {
		t.Errorf("should be ready, waiting on %q", got)
	}
}

func TestDoesNotWaitForAProcessThatDoesNotExist(t *testing.T) {
	// A typo must not hang a process forever. An unknown name is left unresolved
	// and visible in the app's own error, which is a bug the author can see.
	app := appWithCache()
	app.Processes[0].Env = map[string]string{"X": "${process:nosuch}"}
	a := agentWith(map[string]*live{})

	if got := a.waitingOn(app, app.Processes[0]); got != "" {
		t.Errorf("an unknown name is not something to wait for, got %q", got)
	}
}

func TestAProcessDoesNotWaitForItself(t *testing.T) {
	app := appWithCache()
	app.Processes[1].Env = map[string]string{"SELF": "${process:redis}"}
	a := agentWith(map[string]*live{})

	if got := a.waitingOn(app, app.Processes[1]); got != "" {
		t.Errorf("a process cannot wait for itself, got %q", got)
	}
}

func TestAProcessWithNoEnvNeverWaits(t *testing.T) {
	// Every app that declares no dependency at all takes this path, so it must
	// not acquire a reason to be deferred.
	a := agentWith(map[string]*live{})
	if got := a.waitingOn(appWithCache(), Process{Name: "web", Kind: KindWeb}); got != "" {
		t.Errorf("got %q", got)
	}
}

// The address variables a dependency publishes are the APP's, not one
// process's — every process of the app may read them. The first version of this
// checked only the per-process half, so nothing ever waited and an unresolved
// `${process:redis}` reached a live app's environment.

func TestWaitsOnAnAddressInTheAppsEnv(t *testing.T) {
	app := appWithCache()
	app.Env = map[string]string{"REDIS_URL": "redis://${process:redis}:6379"}
	a := agentWith(map[string]*live{})

	if got := a.waitingOn(app, Process{Name: "api", Kind: KindWeb}); got != "redis" {
		t.Errorf("should wait for redis, got %q", got)
	}
}

func TestResolvesAnAddressInTheAppsEnv(t *testing.T) {
	app := appWithCache()
	app.Env = map[string]string{"REDIS_URL": "redis://${process:redis}:6379"}
	got := resolveProcessAddrs(app.Env["REDIS_URL"], app, Process{Name: "api", Kind: KindWeb})
	if got != "redis://10.200.1.9:6379" {
		t.Errorf("got %q", got)
	}
}
