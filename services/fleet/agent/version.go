package main

// Version is stamped at build time with
//
//	-ldflags "-X main.Version=<commit sha>"
//
// It defaults to "dev" so that a binary built by hand says so. An unstamped
// build claiming a real version would be worse than useless: the whole point of
// this field is to tell a node running last week's agent from one running main,
// and a confident wrong answer there is what this is being added to end.
var Version = "dev"

// versionLine is what `supersonicd -version` prints.
//
// The shape is an interface, not a log line: the updater (image/update-agent.sh)
// runs the freshly downloaded binary with -version and refuses to install
// anything that does not answer in this form. That check is the only thing
// standing between a truncated download and a node with no agent.
func versionLine() string { return "supersonicd " + Version }
