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
