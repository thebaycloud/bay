package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// What the node did to an app, written where the app's own logs already go.
//
// The agent has always known when it placed an app, restarted it after a crash,
// or gave up on it — and said so only in its own log, under
// /var/log/supersonicd.log, which carries no app label. So "why did my app
// restart at 3am" was unanswerable by anyone who did not have shell on the node.
//
// The trick is the filename. The ops agent already ships /srv/apps/*/*.log with
// `record_log_file_path`, and the control plane's reader already anchors on
// `^/srv/apps/<slug>/` — so a file called platform.log beside app.log arrives
// labelled with the right app, through plumbing that exists, needing no config
// change on the node and no new permission. The reader names the source from the
// filename; see `processOf` in apps/web/lib/logs.ts.
//
// Best effort, always. A node that cannot write this file must still run the
// app: an unwritable log is not a reason to fail a deploy, and every call here
// swallows its error deliberately rather than by omission.

// platformLogPath is the app's lifecycle log, beside its stdout.
func platformLogPath(app App) string {
	if app.LogPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(app.LogPath), "platform.log")
}

// noteApp records one thing the node did to one app.
//
// Written as JSON so the message survives having a colon in it, and so the
// fields are there the day something parses them. Today the reader shows the
// `msg`, which is why it is written to be read by a person first.
func noteApp(app App, level, msg string) {
	path := platformLogPath(app)
	if path == "" {
		return
	}
	line, err := json.Marshal(struct {
		At    string `json:"at"`
		Level string `json:"level"`
		Msg   string `json:"msg"`
	}{time.Now().UTC().Format(time.RFC3339), level, msg})
	if err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

// notef is noteApp with a format string, for the call sites that have one.
func notef(app App, level, format string, args ...any) {
	noteApp(app, level, fmt.Sprintf(format, args...))
}
