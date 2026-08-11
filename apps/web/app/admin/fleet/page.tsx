export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { currentAdminEmail } from "@/lib/admin";
import { formatDuration } from "@/lib/analytics/metrics";
import { gib, readFleetStatus } from "@/lib/fleet-status";
import { Caveat, Empty, Panel, Section, StatTile, Table } from "@/components/AnalyticsCharts";

/**
 * What the fleet has been told to hold, and what it says is failing.
 *
 * Until now the only way to see what a node holds was to ssh to it and curl
 * 127.0.0.1:9900/status. An operator without ssh — or with an expired gcloud
 * token — was blind during exactly the incident where being blind costs most.
 * Everything here comes from the control plane's own tables, so it answers when
 * the node does not.
 *
 * Server-rendered, read-only, and there is no control on it. Gate, layout and
 * components are `app/admin/analytics/page.tsx`'s, deliberately: a second
 * operator page that invented its own auth would be a second thing to get wrong,
 * and there is no new CSS here at all.
 *
 * The design rule is that page's: a number that could mislead carries the reason
 * next to it. On this page all three of those reasons are consequences of how the
 * fleet actually works, and an operator who does not know them will read the page
 * as a health check — which it is not, and cannot be.
 */

const ago = (seconds: number) => (Number.isFinite(seconds) ? `${formatDuration(seconds * 1000)} ago` : "—");

export default async function FleetPage() {
  const operator = await currentAdminEmail();
  if (!operator) notFound();

  const snap = await readFleetStatus();

  return (
    <div className="shell">
      <div className="main">
        <div className="scroll">
          <div className="an-page">
            <header className="an-head">
              <div>
                <h2>What the fleet has been told to hold, and what it says is failing.</h2>
                <p>
                  Read-only, from the production database — no ssh, and nothing here can change
                  placement. Signed in as <span className="mono">{operator}</span>.
                </p>
              </div>
            </header>

            {/* Three things that must be read before any number below it. */}
            <div className="an-warn">
              <b>A placement is what the control plane told a node, not what the node is running.</b>{" "}
              Nothing in the ten-second sync reports running processes — only start failures, and
              only until the process starts. No table on this page can say an app is up.
            </div>
            <div className="an-warn">
              <b>
                A node that has not reported in {snap.staleAfterSeconds} seconds is{" "}
                <span className="mono">unknown</span>, not down.
              </b>{" "}
              <span className="mono">KillMode=process</span> means restarting the agent leaves the
              sandboxes serving, so a silent agent does not mean silent apps. Re-placing its apps on
              that reading is how two copies of one app end up running at once.
            </div>
            <div className="an-warn">
              <b>An empty fault list means &ldquo;no node told us anything failed to start&rdquo;.</b>{" "}
              It does not mean a node is reporting: nothing records that a sync carried the field at
              all, an agent built before the field existed sends nothing, and a fault write that
              fails is logged and swallowed so the node keeps receiving its desired state. Hence{" "}
              <span className="mono">heartbeating</span> below, never &ldquo;reporting&rdquo;.
            </div>

            {!snap.ok ? (
              <>
                <div className="an-warn fatal">
                  <b>The fleet could not be read. This page is not showing you an empty fleet.</b>
                  <ul className="an-warn-list">
                    <li>{snap.error}</li>
                  </ul>
                </div>
                {/* Rendered INSTEAD of every table, never beside them. A fleet page
                    with no rows on it is the one thing this must never be mistaken for. */}
                <Panel title="The fleet" error={snap.error}>
                  <Empty>unreachable</Empty>
                </Panel>
              </>
            ) : (
              <>
                <div className="an-tiles">
                  <StatTile
                    label="nodes"
                    value={String(snap.counts.nodes)}
                    sub={`${snap.counts.heartbeating} heartbeating · ${snap.counts.nodes - snap.counts.heartbeating} unknown`}
                    hint="Rows in fleet_nodes. A node registers itself; nothing else creates one."
                  />
                  <StatTile
                    label="placements"
                    value={String(snap.counts.placements)}
                    sub="apps a node has been told to hold"
                    hint="One row per (app, node). Two rows for one app means two copies."
                  />
                  <StatTile
                    label="processes reported failing"
                    value={String(snap.counts.faults)}
                    sub="start failures, as the node classified them"
                    hint="A process that started is absent from this table, so zero is not a health check."
                  />
                  <StatTile
                    label="of those, shielding a deploy"
                    value={String(snap.counts.shielding)}
                    sub="fresh node faults with a placement"
                    hint="These would mark the app's next failed deploy as the platform's fault, keeping the repair agent away from the customer's repository."
                  />
                </div>

                <Section title="Nodes" blurb="The machines, and how long ago each last said anything.">
                  <Panel title={<>{snap.nodes.length} node{snap.nodes.length === 1 ? "" : "s"}</>}>
                    <Table
                      columns={["node", "zone", "address", "cpus", "memory", "state", "agent", "last heard from", "placed", "failing"]}
                      rows={snap.nodes.map((n) => [
                        n.name,
                        n.zone,
                        n.internalIp,
                        n.cpus,
                        gib(n.memoryBytes),
                        // Two separate facts, never collapsed: a node can be
                        // draining AND silent, and reading that as an orderly
                        // drain is how a silent machine gets ignored.
                        n.drain ? `${n.freshness} · draining` : n.freshness,
                        // "unknown", never blank: a node whose agent is too old
                        // to say which build it is looks identical to a current
                        // one, and that is the confusion that let fleet-pull and
                        // fleet-boot ship and write zero rows.
                        n.agentVersion ?? "unknown",
                        ago(n.lastSeenAgeS),
                        n.placed,
                        n.faults,
                      ])}
                      emptyText="No node has ever registered."
                    />
                    <Caveat>
                      <span className="mono">last heard from</span> is the node&rsquo;s own ten-second
                      sync. <span className="mono">placed</span> counts what it has been told to
                      hold; <span className="mono">failing</span> counts processes it reported could
                      not start, which is not the same as processes that are down.
                    </Caveat>
                  </Panel>
                </Section>

                <Section title="Placements" blurb="Which app each node has been told to hold, and what it was told to run.">
                  <Panel title={<>{snap.placements.length} placement{snap.placements.length === 1 ? "" : "s"}</>}>
                    <Table
                      columns={["app", "node", "node state", "runtime", "image", "port", "processes", "placed", "failing"]}
                      rows={snap.placements.map((p) => [
                        p.slug,
                        p.node,
                        p.nodeFreshness ?? "no node row",
                        p.runtime ?? "no apps row",
                        String(p.spec.image ?? "—"),
                        String(p.spec.port ?? "—"),
                        (p.spec.processes ?? []).map((q) => `${q.name}:${q.kind}`).join(" ") || "implicit web",
                        ago(p.placedAgeS),
                        p.faults.length,
                      ])}
                      emptyText="Nothing is placed on the fleet."
                    />
                    <Caveat>
                      The spec column shows the image, port and process names only. Everything else a
                      placement carries — the environment, the Secret Manager references, the start
                      commands — is withheld by construction rather than filtered here: an app&rsquo;s
                      resolved environment contains its database credentials whenever Secret Manager
                      refused a key, and a page is the wrong place for those.{" "}
                      <span className="mono">implicit web</span> means the spec declared no
                      processes, which the agent reads as one web process built from the app&rsquo;s
                      own port and health path.
                    </Caveat>
                  </Panel>
                </Section>

                <Section
                  title="What the fleet is complaining about"
                  blurb="Start failures the nodes classified themselves, and placements that do not add up."
                >
                  <Panel title={<>{snap.counts.faults} reported fault{snap.counts.faults === 1 ? "" : "s"}</>}>
                    {snap.placements.every((p) => !p.faults.length && !p.warnings.length) &&
                    !snap.orphanFaults.length ? (
                      <Empty>
                        No node has reported a start failure, and every placement lines up. That is
                        not the same as every app being up.
                      </Empty>
                    ) : (
                      <ul className="an-warn-list">
                        {snap.placements.map((p) =>
                          [...p.faults.map((f) => (
                            <li key={`${p.slug}/${p.node}/${f.process}`}>
                              <span className="mono">
                                {p.slug} on {p.node} · {f.process}
                              </span>{" "}
                              — the node blamed{" "}
                              <b>
                                {/* Verbatim, including a value this reader does not know:
                                    014_fleet_status.sql refuses a CHECK constraint so a newer
                                    agent's vocabulary is stored and ignored, and ignored must
                                    not mean invisible. React escapes it; it is attacker-controlled
                                    text from any FLEET_TOKEN holder and is bounded on render. */}
                                {f.fault || "nothing"}
                              </b>
                              {f.known ? "" : " (a value this page does not recognise)"}, {ago(f.reportedAgeS)}
                              {f.detail && (
                                <>
                                  {" — "}
                                  <span className="mono">{f.detail}</span>
                                  {f.detailTruncated && <> (truncated)</>}
                                </>
                              )}
                              {f.shieldsDeploys ? (
                                <> · this keeps the repair agent off the app&rsquo;s next failed deploy</>
                              ) : (
                                <> · shields nothing: {f.whyNotShielding.join("; ")}</>
                              )}
                            </li>
                          )),
                          ...p.warnings.map((w, i) => (
                            <li key={`${p.slug}/${p.node}/w${i}`}>
                              <span className="mono">
                                {p.slug} on {p.node}
                              </span>{" "}
                              — {w}
                            </li>
                          ))],
                        )}
                        {snap.orphanFaults.map((f) => (
                          <li key={`orphan/${f.slug}/${f.node}/${f.process}`}>
                            <span className="mono">
                              {f.slug} on {f.node} · {f.process}
                            </span>{" "}
                            — a fault with no placement behind it. Nothing on that node was told to
                            run this app, so the row shields nothing and describes something that
                            was unplaced after it failed.
                          </li>
                        ))}
                      </ul>
                    )}
                    <Caveat>
                      A fault is the node&rsquo;s own verdict on why a process would not start, taken
                      where the fact is: only the node knows whether its own Cloud SQL proxy answered
                      or its service account could read a secret. Text is shown only for a{" "}
                      <span className="mono">node</span> or <span className="mono">app</span> fault —
                      an unclassified failure&rsquo;s error can contain the tail of the app&rsquo;s
                      own log, and that stays on the node. A fault disappears the moment the process
                      it describes starts, so this list is current rather than historical.
                    </Caveat>
                  </Panel>
                </Section>

                <footer className="an-foot">
                  <p>
                    Snapshot taken {snap.at.slice(0, 19).replace("T", " ")} UTC, in a single read-only
                    transaction — so every age above is measured from one instant. Sources:{" "}
                    <span className="mono">fleet_nodes</span>,{" "}
                    <span className="mono">fleet_placements</span>,{" "}
                    <span className="mono">fleet_process_faults</span> and{" "}
                    <span className="mono">apps.runtime</span>.
                  </p>
                  <p>
                    Nothing on this page reaches a node. To see what a node is actually running you
                    still have to ask it — <span className="mono">curl 127.0.0.1:9900/status</span>{" "}
                    on the machine — and this page exists so that is the second thing you try rather
                    than the first.
                  </p>
                </footer>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Same control the rest of the product uses. */}
      <ThemeToggle />
    </div>
  );
}
