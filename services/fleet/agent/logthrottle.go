package main

import (
	"sync"
	"time"
)

// Saying a persistent thing often enough to be seen, and not so often that it
// fills the disk.
//
// Several of this agent's states persist: a release that has given up, a start
// that has given up, a cron whose app is blocked by its own release. Each is
// decided once per reconcile pass, which is once every ten seconds, and the
// existing lines say so every time.
//
// Both extremes are wrong and both have been measured here. Logging once ever
// loses the state to anyone who starts tailing afterwards — and on this node
// there is no other view, which is why the lines were written per-pass in the
// first place. Logging per pass is 8,640 lines a day per stuck app, into
// /var/log/supersonicd.log, which is append-only on a node whose local SSD does
// not survive a stop. Measured on 4 Aug: 9 lines in 82 seconds, ~1 MB/day.
//
// The key is the caller's, and the useful ones carry whatever changes when the
// SITUATION changes — an image, usually. A new deploy is then a new key and is
// announced immediately rather than swallowed by an interval that started
// before it existed. That is why there is no forget().
type logThrottle struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func newLogThrottle() *logThrottle {
	return &logThrottle{seen: map[string]time.Time{}}
}

// pruneAbove bounds the map. Keys carry image digests, so a long-lived node
// with many deploys would otherwise accumulate one entry per image forever.
const pruneAbove = 512

// allow reports whether this key may be logged now, and records the answer.
//
// The first call for a key always allows: a state that has just begun is the
// one a human most wants to see.
func (l *logThrottle) allow(key string, now time.Time, every time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if last, ok := l.seen[key]; ok && now.Sub(last) < every {
		return false
	}

	if len(l.seen) > pruneAbove {
		// Anything not seen in a day belongs to an app, image or process this
		// node no longer holds. Dropping it costs one extra line if it ever
		// comes back, which is the right direction to be wrong in.
		for k, t := range l.seen {
			if now.Sub(t) > 24*time.Hour {
				delete(l.seen, k)
			}
		}
	}

	l.seen[key] = now
	return true
}
