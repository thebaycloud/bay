# Supersonic

The ubiquitous language of this platform. A glossary and nothing else — no
implementation details, no decisions, no plans. Those live in `docs/`.

Started 2026-08-06, during the grilling that opened the move from Cloud Run to
the fleet. Terms are added the moment they are resolved, not in batches.

## Two vocabularies

There are two, and they do not mix.

**Platform language** is what the code, the tables and the logs say. It is precise
and it is ours. It never appears in front of a person — not in a page, not in a
CLI line, not in an error.

**Product language** is what a person reads. Every word in it is one a ten-year-old
already knows. That is not decoration: the words are also what a model learns us
by, so a short, plain, self-describing vocabulary is the interface, not the skin.

A term that appears in both lists means the same thing in both. A platform term
with no product counterpart is a term a person should never encounter.

## Platform language

**Fleet**:
The Compute Engine VMs that run users' apps, taken together. The canonical word
for this — it is what the code and the tables already say (`fleet_nodes`,
`fleet_placements`, `services/fleet/agent`).
_Avoid_: VM, VMs, the cluster, the machines. "VM" is fine in conversation and
belongs nowhere in code, a table, or a document.

**Node**:
One machine in the **Fleet**. Has a name (`fleet-lab-1`), runs the agent, and
holds **Placements**.
_Avoid_: instance, box, server, host.

**Placement**:
The record that a given app is meant to run on a given **Node**. A statement of
intent, not of fact — an app can be placed on a node that is not yet running it.
_Avoid_: assignment, scheduling, allocation.

**Process**:
One thing an app runs — `web`, `worker`, `cron`, `release`. An app has one or
more. Distinct from a container: two processes can share an image.
_Avoid_: service (that word belongs to Cloud Run), job, task.
Has no product counterpart. A person never reads this word.

**Deploy target**:
Where an app's processes end up running. Today there are two — the **Fleet**, and
Cloud Run. Naming the concept is what makes "which one" a decision rather than
an assumption.
Has no product counterpart.

## Product language

**App**:
The thing a person made. The only word for it.
_Avoid_: project, site, service, workload, deploy target.

**Room**:
Where a person watches their app get built, at the app's own address, before the
app has ever answered. Every movement in it stands for a real event; a room that
animates without something having happened is a lie.
_Avoid_: build page, loading screen, progress page, preview.

**Open**:
The moment the **Room** becomes the app. Not a transition between two pages — the
same address, now answering for itself.
_Avoid_: launch, go live, cut over, promote, handover.

**Door**:
A way into an app from outside.
_Avoid_: route, endpoint, path, ingress.

**Attached domain**:
A domain a person owns, pointed at their app. An additional **Door**, never a
replacement one: the app keeps answering at `<slug>.supersonic.cv`, which is the
address every share link, log line and rebuild is still built from. Product
language says *your own domain*.
_Avoid_: custom domain (in front of a person), vanity URL, CNAME, domain mapping.

**Shadow**:
A copy of an app that is given the same real traffic and answers nobody. Exists
so a change can be watched before it is real.
_Avoid_: canary, blue-green, preview environment, staging.

**X-ray**:
What an owner sees when they look inside their own app: what it is doing, what
happened to it, and who is in it. Reached two ways — brought up over the live app
at its own address, or opened as the app's own page. One thing seen from two
sides, never two things.
Visible to the owner, never to a visitor.
_Avoid_: dashboard, console, overlay, panel, devtools, observability.

**Reading**:
Everything the X-ray shows about one app at one moment, as a single thing. A
person and an agent are given the same reading and only the rendering differs;
two readings built separately would drift, and the one that drifted would be the
one nobody was looking at. Every reading says what window it is true for.
_Avoid_: state, payload, response, DTO, model, view model.

**Secrets**:
The only thing that cannot be written in the code.
_Avoid_: environment variables, config, settings.

**Timeline**:
Every version of an app, in order, walkable. Moving along it is **rewind**;
going back to a version that worked is **undo**.
_Avoid_: releases, revisions, deployments, history, rollback.

**Ship**:
What a person does when they send their work out. The act.
_Avoid_: deploy (as a noun in front of a person), publish, push, release.

**Build**:
One attempt at shipping. Has a beginning, an end and an outcome.
_Avoid_: deployment, run, job, revision.

**What happened**:
Everything an app did, in one place, for a person and for an agent to read.
_Avoid_: logs, metrics, traces, telemetry, events.

**Who's here**:
The people in an app right now.
_Avoid_: analytics, sessions, active users, presence.

**Who did it**:
Which of *you*, *an agent* or *the platform* caused a thing that happened. Asked
of every **Build**. When nobody said, the answer is *someone* — never a guess,
because a wrong name here is worse than no name.
_Avoid_: actor, trigger, source, initiator, user_id.

## Terms being retired

**Lane** — *do not use in new code.*
Two exported types share this name today (`lib/lanes.ts` and `lib/stages.ts`),
overlapping on two values and disagreeing on the rest. Neither TypeScript nor
Postgres can catch the disagreement. It is being removed rather than renamed:
the two types are two different concepts that were never one, and each needs its
own name once those concepts are stated. Recorded here so nothing new is built on
it in the meantime.

## Relationships

- The **Fleet** contains many **Nodes**
- A **Node** holds many **Placements**
- A **Placement** names one app on one **Node**
- An app runs one or more **Processes**
- An **App** has a **Timeline** of **Builds**
- An **App** has one **Room**, until it **opens** for the first time
- An **App** may have a **Shadow**
- An **App** may have any number of **Attached domains**; each belongs to one app

## Resolved ambiguities

- **"Deploy"** named two things: the act a person performs and one attempt at it
  recorded in `deploy_stages`. Resolved 2026-08-08 by splitting them in product
  language: the act is **ship**, one attempt is a **build**. `deploy` survives as
  a CLI alias for `ship` and throughout platform language, where the `run_id`
  bound already makes the second meaning unambiguous.
