# Supersonic

The ubiquitous language of this platform. A glossary and nothing else — no
implementation details, no decisions, no plans. Those live in `docs/`.

Started 2026-08-06, during the grilling that opened the move from Cloud Run to
the fleet. Terms are added the moment they are resolved, not in batches.

## Language

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

**Deploy target**:
Where an app's processes end up running. Today there are two — the **Fleet**, and
Cloud Run. Naming the concept is what makes "which one" a decision rather than
an assumption.

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

## Flagged ambiguities

- **"Deploy"** is used for two things: the act a user performs (`supersonic
  deploy`) and one attempt at it recorded in `deploy_stages`. The second is
  bounded by a `run_id`. Not yet resolved — flagged so the next person who needs
  the distinction names it rather than guessing.
