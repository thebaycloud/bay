export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { maySeeSecrets, ownedBy, placementsOf, readSecret } from "@/lib/secret-broker";
import { verifyNodeIdentity, identityVerdict, identityMode } from "@/lib/node-identity";

/**
 * The secret broker: the node asks, the placement table answers.
 *
 * Replaces the node reading Secret Manager directly with its own service
 * account, which today holds `secretmanager.secretAccessor` project-wide and
 * unconditioned — one escape from one sandbox reads every tenant's database
 * password. See lib/secret-broker.ts for the decision; this file is the door.
 *
 * ## What this endpoint is worth today, stated exactly
 *
 * `FLEET_TOKEN` is shared by the whole fleet, so it proves "a node" and not
 * "which node". A compromised node can therefore still claim to be another node
 * and read the apps placed there. That is a real limit and it is written here
 * rather than in a commit message, because someone will otherwise read the
 * per-node check below as a guarantee it is not yet able to make.
 *
 * The endpoint is still a large gain, and precisely this much of one:
 *
 *   - the node's service account loses secret access ENTIRELY, so a sandbox
 *     escape that steals the metadata token gets nothing — today it gets every
 *     secret in the project, including the platform's own;
 *   - the reachable set shrinks from "every secret in the project" to "secrets
 *     of apps currently placed, held by a live lease";
 *   - `fleet-edge-secret`, the control plane's database password and every other
 *     platform secret leave the reachable set altogether, since none of them is
 *     named `app-<slug>-<KEY>`.
 *
 * THE PER-NODE CLAIM IS NOW TRUE, as of 12 Aug, and the paragraph above is kept
 * because it describes what this endpoint is worth WITHOUT it. Every request
 * also carries `X-Supersonic-Node-Identity`: a GCE instance identity token,
 * minted by the metadata server for one virtual machine and signed by Google, so
 * the node's name is inside the signature rather than in the body. The check is
 * below, beside the placement test it strengthens.
 *
 * `NODE_IDENTITY=enforce` refuses a request that carries no such token at all.
 * Until every node is sending one it audits instead — but a token that
 * CONTRADICTS the body is refused in either mode, because that is not a rollout
 * gap, it is the thing the mechanism was built to catch.
 */
function authorised(req: Request): boolean {
  const expected = process.env.FLEET_TOKEN;
  if (!expected) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * How many secrets one request may name.
 *
 * A bound on the array, not a security control, and the difference decides the
 * number. The caller already holds FLEET_TOKEN, so an attacker who has it can
 * ask for every app in turn regardless — a low cap buys nothing against them
 * and costs a legitimate app its start, since `env set` puts no limit on how
 * many secrets an app may have. This is high enough that no real app reaches it
 * and low enough that the array and its concurrent fetches stay bounded.
 *
 * It was 32 first, which is inside the range a real app can reach.
 */
const MAX_NAMES = 100;

export async function POST(req: Request) {
  if (!authorised(req)) return Response.json({ error: "unauthorised" }, { status: 401 });

  let body: { node?: unknown; slug?: unknown; names?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const node = typeof body.node === "string" ? body.node : "";
  const slug = typeof body.slug === "string" ? body.slug : "";
  // Filtering non-strings out would turn `names: [123]` into an empty list and
  // then into a cheerful `{values:{}}`, which the agent reads as "this app has
  // no secrets" and starts the process without them. Refused instead.
  const raw = Array.isArray(body.names) ? body.names : [];
  if (raw.some((n) => typeof n !== "string")) {
    return Response.json({ error: "names must be strings" }, { status: 400 });
  }
  const names = raw as string[];
  if (!node || !slug) return Response.json({ error: "node and slug are required" }, { status: 400 });
  if (!names.length) return Response.json({ values: {} });
  if (names.length > MAX_NAMES) {
    return Response.json({ error: `at most ${MAX_NAMES} secrets per request` }, { status: 400 });
  }

  // Ownership before placement, because it needs no database round trip and a
  // request naming another app's secret is not a question worth asking the
  // table. Reported as one refusal listing every offending name rather than
  // failing on the first: a node fixing its spec should learn all of it at once.
  const foreign = names.filter((n) => !ownedBy(slug, n));
  if (foreign.length) {
    return Response.json(
      { error: `not ${slug}'s to read: ${foreign.join(", ")}` },
      { status: 403 },
    );
  }

  // WHICH node is asking, checked against what it says it is.
  //
  // `FLEET_TOKEN` proves membership and nothing else — the header at the top of
  // this file says so — so `node` above is a claim the caller makes about
  // itself. `X-Supersonic-Node-Identity` is that same claim signed by Google for
  // one virtual machine, and this is where the two are compared.
  //
  // A MISMATCH IS REFUSED EVEN WHILE AUDITING. Auditing is about a header that
  // is ABSENT, because nodes collect a new agent on their own two-minute timer
  // and a fleet mid-rollout has both kinds. It is never about a header that
  // contradicts the request, which is the one thing this mechanism exists to
  // catch.
  const identity = await verifyNodeIdentity(req.headers.get("x-bay-node-identity") ?? req.headers.get("x-supersonic-node-identity") ?? "");
  const check = identityVerdict(node, identity, identityMode(process.env));
  if (!check.ok) {
    console.error(`secret-broker: refused ${slug} — ${check.reason}`);
    return Response.json({ error: check.reason ?? "identity refused" }, { status: 403 });
  }
  if (check.audited) {
    // Logged rather than silent: a fleet where every request is audited looks
    // exactly like a fleet where the feature works, and the difference decides
    // when NODE_IDENTITY can be turned to `enforce`.
    console.error(`secret-broker: ${node} sent no verifiable identity (auditing)`);
  }

  let verdict;
  try {
    verdict = maySeeSecrets(await placementsOf(slug, node), { node, slug }, Date.now());
  } catch (e) {
    // A database that cannot answer must REFUSE, never allow. This is the one
    // place in the fleet path where failing open would be catastrophic rather
    // than merely degrading — the reconciler's outage story is "nothing moves",
    // and this one's has to be "nothing new is read".
    console.error("secret-broker: could not read placements", e instanceof Error ? e.message : String(e));
    return Response.json({ error: "the placement table is not answering" }, { status: 503 });
  }
  if (!verdict.ok) return Response.json({ error: verdict.reason ?? "refused" }, { status: 403 });

  // Concurrent for the same reason `resolveAll` in the agent is: an app with a
  // database has several secrets and doing them in series adds a round trip to
  // every cold start.
  const settled = await Promise.allSettled(names.map((n) => readSecret(n)));
  const values: Record<string, string> = {};
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") values[names[i]] = r.value;
    else failed.push(`${names[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });

  // ALL OR NOTHING. A partial answer would let a node start an app with some of
  // its environment, and the agent's own rule — a secret that cannot be resolved
  // fails the start — exists because such a process comes up, passes a health
  // check on "/", and fails every request that touches data.
  if (failed.length) {
    return Response.json({ error: failed.join("; ") }, { status: 502 });
  }
  return Response.json({ values });
}
