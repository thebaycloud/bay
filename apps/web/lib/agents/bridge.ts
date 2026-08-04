import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The redeploy bridge: the only thing in this system that decides whether a
 * repair worked.
 *
 * The agent runs `redeploy.sh`, which POSTs here, and this runs the real
 * pipeline. Success is `lastUrl` — never the agent's prose. An agent that says
 * it fixed something and an agent that fixed something are different agents, and
 * only one of them is detectable from out here.
 *
 * The bind address is a PARAMETER, and that is the whole reason this file
 * exists separately. Today the agent is a subprocess of this process and
 * `127.0.0.1` is correct. In a gVisor sandbox on a fleet node, `127.0.0.1` is the
 * sandbox's own loopback and the bridge is not on it — the sandbox reaches the
 * node at its bridge gateway (`10.200.0.1`, see `services/fleet/agent/network.go`).
 * Hardcoding loopback is what would make that move a rewrite instead of a flag.
 */

export type Redeploy = () => Promise<{ ok: boolean; url?: string; error?: string }>;

export interface BridgeOptions {
  redeploy: Redeploy;
  log: (l: string) => void;
  /** How many real builds this repair may spend. */
  maxRedeploys: number;
  /** Interface to listen on. Loopback when the agent is a local subprocess. */
  bind?: string;
  /** Compare two failures — same cause, or different? */
  sameFailure: (a: string | undefined, b: string | undefined) => boolean;
}

export interface Bridge {
  /** The URL the agent should POST to, as it can reach it. */
  url: string;
  port: number;
  /** The last successful deploy URL. This is the ground truth. */
  lastUrl(): string | undefined;
  redeploys(): number;
  close(): void;
}

export async function startBridge(o: BridgeOptions): Promise<Bridge> {
  const bind = o.bind || "127.0.0.1";
  let lastUrl: string | undefined;
  let redeploys = 0;
  let repeatedFailures = 0;
  let lastFailure: string | undefined;

  /**
   * A real redeploy is a full cloud build and outlives the agent's bash-tool
   * timeout, so the agent kills `redeploy.sh` mid-build and retries. That must
   * NOT start a second build: two racing on one slug can leave the release
   * pointer on an incomplete one. A retry attaches to the same promise and gets
   * its real result.
   */
  let inFlight: Promise<{ ok: boolean; url?: string; error?: string }> | null = null;

  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/redeploy") {
      res.writeHead(404);
      res.end();
      return;
    }
    const reply = (r: { ok: boolean; url?: string; error?: string }) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
    };

    if (inFlight) {
      inFlight.then(reply).catch((e) => reply({ ok: false, error: String(e) }));
      return;
    }
    if (redeploys >= o.maxRedeploys) {
      reply({ ok: false, error: "redeploy limit reached — stop and report what is blocking" });
      return;
    }
    if (repeatedFailures >= 1) {
      // The attempt counter could say the agent had run out of tries; it could
      // never say it had run out of ideas. Two deploys failing the same way are
      // not evidence a third will differ — they are evidence the edits in
      // between are not touching the cause.
      //
      // `>= 1`, not `>= 2`, and this is a deliberate correction to the logic
      // this was lifted from. The counter only increments on the SECOND
      // identical failure, so `>= 2` needed three of them — and with the default
      // budget of three redeploys the limit check above always fired first. The
      // guard could not run at all on a default deployment, and its own message
      // says "the last two". Now two means two.
      reply({
        ok: false,
        error: `the last two deploys failed for the same reason — stop editing and report what is blocking:\n${lastFailure}`,
      });
      return;
    }

    redeploys++;
    o.log(`agent · redeploying (attempt ${redeploys})…`);
    inFlight = o.redeploy();
    inFlight
      .then((r) => {
        inFlight = null;
        if (r.ok) {
          lastUrl = r.url;
          repeatedFailures = 0;
          o.log("agent · redeploy succeeded");
        } else {
          repeatedFailures = o.sameFailure(lastFailure, r.error) ? repeatedFailures + 1 : 0;
          lastFailure = r.error;
          o.log(repeatedFailures ? "agent · same failure as last time" : "agent · still failing, iterating");
        }
        reply(r);
      })
      .catch((e) => {
        inFlight = null;
        reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
      });
  });

  await new Promise<void>((r) => server.listen(0, bind, () => r()));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://${bind}:${port}`,
    lastUrl: () => lastUrl,
    redeploys: () => redeploys,
    close: () => server.close(),
  };
}

/**
 * The script the agent runs.
 *
 * Takes the bridge's URL rather than building it from a port, so the same script
 * works whether the bridge is on this machine's loopback or on the node gateway.
 */
export function redeployScript(bridgeUrl: string): string {
  return `#!/usr/bin/env bash
# Bridge to the real Supersonic deploy pipeline.
set -uo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
R=$(curl -s -X POST "${bridgeUrl}/redeploy" --max-time 1200)
OK=$(node -e 'try{process.stdout.write(String(JSON.parse(process.argv[1]).ok))}catch{process.stdout.write("false")}' "$R")
URL=$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).url||"")}catch{}' "$R")
ERR=$(node -e 'try{process.stdout.write(JSON.parse(process.argv[1]).error||"")}catch{}' "$R")
if [ "$OK" = "true" ]; then
  echo "DEPLOY_OK: $URL"
  printf '{"ok":true,"url":"%s"}' "$URL" > "$HERE/.deploy.result"
else
  echo "DEPLOY_FAIL: $ERR"
  printf '{"ok":false}' > "$HERE/.deploy.result"
fi
`;
}
