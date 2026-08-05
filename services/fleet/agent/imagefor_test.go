package main

import "testing"

// Every process of an app used to share one image. That is right for web,
// worker and release — the same code entered differently — and wrong for
// anything an app needs BESIDE itself: a sibling service builds its own image,
// and a dependency like Redis is somebody else's entirely.
//
// The risk in adding the field is not the start; it is that adoption, the
// restart-on-change comparison, the release key and the failure counters all
// key on an image. Two of them reading different answers means a process
// restarted forever, or never.

func TestImageForFallsBackToTheApp(t *testing.T) {
	app := App{Slug: "a", Image: "registry/a@sha256:aaa"}
	if got := imageFor(app, Process{Name: "web", Kind: KindWeb}); got != app.Image {
		t.Errorf("a process with no image of its own should run the app's: got %q", got)
	}
}

func TestImageForPrefersTheProcess(t *testing.T) {
	app := App{Slug: "a", Image: "registry/a@sha256:aaa"}
	proc := Process{Name: "cache", Kind: KindWorker, Image: "docker.io/library/redis:7"}
	if got := imageFor(app, proc); got != proc.Image {
		t.Errorf("a process that names an image should run it: got %q", got)
	}
}

func TestImageForIsWhatTheManifestRecords(t *testing.T) {
	// The manifest is what adoption reads back after an agent restart, and it is
	// compared against what desired state asks for. If the two derive the image
	// differently, a surviving sandbox is never claimed and every app bounces.
	bundle := t.TempDir()
	app := App{Slug: "a", Image: "registry/a@sha256:aaa"}
	proc := Process{Name: "cache", Kind: KindWorker, Image: "docker.io/library/redis:7"}
	if err := writeManifest(bundle, app, proc, 3); err != nil {
		t.Fatalf("writeManifest: %v", err)
	}
	m, err := readManifest(bundle)
	if err != nil {
		t.Fatalf("readManifest: %v", err)
	}
	if m.Image != proc.Image {
		t.Errorf("manifest recorded %q, desired state derives %q", m.Image, imageFor(app, proc))
	}
}

func TestImageForEmptyStringIsNotAnImage(t *testing.T) {
	// An explicit empty string is the JSON default for an absent field, and it
	// must mean "the app's", not "run nothing".
	app := App{Slug: "a", Image: "registry/a@sha256:aaa"}
	if got := imageFor(app, Process{Name: "web", Kind: KindWeb, Image: ""}); got != app.Image {
		t.Errorf("empty is absent: got %q", got)
	}
}

// A changed environment is a reason to restart, and it was not one. `supersonic
// env set` writes the placement spec; the node compared image and command,
// found both unchanged, and left the process running with the value the user
// had just replaced. The command reported success.

func TestSameStringMapTreatsNilAndEmptyAsEqual(t *testing.T) {
	// A spec that omits `env` and one that sends `{}` say the same thing, and
	// reading them as different would restart every app on the first sync after
	// a deploy that dropped its last variable.
	if !sameStringMap(nil, map[string]string{}) {
		t.Error("nil and empty are the same environment")
	}
}

func TestSameStringMapNoticesEveryKindOfChange(t *testing.T) {
	base := map[string]string{"LOG_LEVEL": "info", "REGION": "us"}
	for name, other := range map[string]map[string]string{
		"a changed value": {"LOG_LEVEL": "debug", "REGION": "us"},
		"a removed key":   {"LOG_LEVEL": "info"},
		"an added key":    {"LOG_LEVEL": "info", "REGION": "us", "NEW": "1"},
		"a renamed key":   {"LOG_LEVEL": "info", "ZONE": "us"},
		"nothing at all":  {},
	} {
		if sameStringMap(base, other) {
			t.Errorf("%s should be a restart", name)
		}
	}
}

func TestSameStringMapIsNotOrderOrIdentity(t *testing.T) {
	// Same content, different map. Restarting on identity rather than content
	// would restart every process on every sync.
	if !sameStringMap(map[string]string{"B": "2", "A": "1"}, map[string]string{"A": "1", "B": "2"}) {
		t.Error("same content is the same environment")
	}
}
