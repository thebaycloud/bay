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
