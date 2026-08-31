# How an account arrived is a quote the agent copies, not a question it answers

Bay's CLI is run by coding agents. That is the product — `bay ship` is designed
to be typed by Claude Code or Cursor on somebody's behalf, and `index.js` opens
by saying so: "Designed for agents, not humans: no interactive prompts."

It also means the signup funnel has two completely different populations in it
and no way to tell them apart. One user said "deploy this to baycloud"; the
other said "find me a cloud and ship this" and their agent picked us. Both
arrive as one row in `users`. The first is the ordinary business of a product
people have heard of. The second is the one we cannot buy, cannot see, and would
be growing or losing blind. A signup count contains both and distinguishes
neither.

So the first sign-in on a machine carries `--via`, and this ADR is about the two
decisions inside that flag that were not obvious.

## Ask for the sentence, not the classification

The first design was `--via user|agent`, or an interactive "Are you an AI agent?
Did the user name Bay?" at install time. Both are worse, for the same reason.

An interactive prompt is out on its face: agents do not answer prompts, they
hang on them, and a question at install time is a question asked of a machine
that is trying to finish a task.

The label is subtler and still wrong. An agent asked to classify its own
situation answers with whatever moves it forward, and it is being asked to
introspect — "did this come from the user or from me?" is a question about its
own context that it has no incentive to get right and every incentive to answer
quickly. An agent asked to **copy a sentence that is already in front of it**
has nothing to get wrong. So the flag takes the user's request verbatim, and
`lib/acquisition.ts` decides what it means, on the server, from the evidence:
does the request name us, or does it name a need.

The corpus turns out to be worth more than the bit it produces. `chosen` quotes
are the list of requests we are winning, written by the people making them —
which is the thing to write documentation against, and no boolean contains it.

## It blocks, exactly once, and pays for that three ways

This is the only place in the CLI that fails a command to ask for something, and
that is a real exception to the doctrine at the top of `index.js`.

It is deliberate, because a suggestion on stderr does not work. An agent ignores
anything that does not stand between it and the goal, and obeys a non-zero exit
whose message names the command to run instead — that is its entire working
loop. A soft nag would be answered by roughly half of them; a hard failure with
the fix printed inside it is answered by nearly all.

The exception is bounded by three rules, and all three matter:

- **`--via unknown` always satisfies it.** Nobody is ever stuck, and "asked,
  could not answer" stays a different fact from "never asked" — which keeps the
  coverage of this column honest and readable.
- **Only a new arrival is asked.** `bay signup`, and `bay ship` finding itself
  signed out. Not `bay login`: somebody typing that is a returning user on a
  second laptop, and asking them how they found us is an interrogation of the
  one participant who is not the intended audience.
- **A machine that has signed in before is never asked again.** `seen` in
  `~/.bay/config.json`, written on every successful authentication and — unlike
  the token and the email — deliberately NOT removed by `bay logout`. It is not
  a credential, it is a memory of having been here.

What none of that fixes: an agent on a fresh machine, for an account that
already exists, is asked and answered and the server discards the answer as
second touch. That costs one flag, paid by the party the question is addressed
to. The alternative is knowing which account you are before you authenticate,
which is not a thing that exists.

## First touch, enforced by the WHERE clause

`users.acquisition_via` is written by `UPDATE … WHERE id = $1 AND
acquisition_via IS NULL`. Not a read-then-write: two machines signing in in the
same second are one statement each and the second matches no rows. Signing in
again from a laptop six months later cannot rewrite how you originally arrived,
and that property is the only thing that makes the column worth reading.

The classification is stored beside the quote rather than computed at read time,
so that improving the classifier later cannot silently rewrite history.

## The quote is shown to the human who is standing right there

`--via` is a fragment of what somebody typed to their assistant, and it is being
sent to us by a third party on their behalf. That is worth being careful about.

The loopback flow already opens a browser, and that page — `/cli` — is the one
screen in an otherwise fully automated path with a human looking at it. So the
quote rides the hand-off the browser was already making, and the authorize
screen shows it back, as a labelled row, before the button that hands over the
credential. Disclosure at the moment of consent, with no second endpoint and no
second round trip.

## Nothing here may fail a sign-in

`recordFirstTouch` returns false and logs on any error, and adds its own columns
once per process with `ADD COLUMN IF NOT EXISTS`. Migrations in this repository
are applied by hand, so the control plane can be serving this code for days
before `db/038_acquisition.sql` has been run against production — and every
sign-in in that window would otherwise hit an undefined column inside the token
mint. An account that cannot finish signing in because of an analytics column
would be a self-inflicted outage in exchange for a chart.
