import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Proving WHICH node is talking, rather than that A node is.
 *
 * ## What this replaces
 *
 * `FLEET_TOKEN` is one string shared by the whole fleet. It proves membership
 * and nothing else, which the secret broker's own header already admits: a
 * compromised node can claim to be another node and read the secrets of the apps
 * placed there. Every per-node check in this codebase — the broker's placement
 * test, the sync route's heartbeat — is written against a name the caller
 * supplies about itself.
 *
 * A GCE instance identity token is minted by the metadata server for ONE virtual
 * machine, signed by Google, and carries that machine's name. It cannot be
 * copied off a node and used to impersonate a different one, because the name is
 * inside the signature.
 *
 * ## Why the node can mint one at all
 *
 * `provision.sh` drops every packet to the metadata server except from uid 0 and
 * 987 — that rule is what keeps tenants away from the node's credentials, and it
 * is why the identity endpoint answers 000 from a normal shell and 200 from
 * root. The agent runs as root (`User=root`, and it must: it creates network
 * namespaces and drives runsc), so it is on the allowed side of that rule.
 *
 * ## The split
 *
 * `nodeFromClaims` is the half with judgement in it and no network: which claims
 * are required, and what they have to say. `verifyNodeIdentity` adds the
 * signature check, which needs Google's keys and therefore a fetch.
 */

/**
 * What the node asks Google to mint the token FOR.
 *
 * An audience is a string, not a secret — anyone can ask for a token with this
 * value. It is what stops a token minted for a DIFFERENT service being replayed
 * here, and nothing more, which is why the project is checked separately.
 */
export const NODE_AUDIENCE = "https://supersonic.cv/fleet";

/**
 * Audiences a node token may carry, newest first.
 *
 * The audience is baked into the agent binary and the agent runs on a VM image.
 * A node provisioned before the rename asks Google for a token with the old
 * audience and will keep doing so until it is re-imaged; a node built after
 * asks for the new one. A verifier that knows one audience refuses every node
 * on the other side of that line — and a refused node is a node whose apps
 * cannot fetch their secrets.
 *
 * So both are accepted. The old one goes when no node older than the rename is
 * on the fleet, which is a thing to check rather than a date to pick.
 */
export const ACCEPTED_NODE_AUDIENCES = [
  "https://thebay.cloud/fleet",
  NODE_AUDIENCE,
] as const;

/** The only project whose instances are this fleet. */
const PROJECT = "supersonic-deploy-prod";

/** Google's issuer for instance identity tokens. */
const ISSUER = "https://accounts.google.com";

export interface NodeIdentity {
  /** The instance name, as GCE knows it — `fleet-lab-1`. */
  node: string;
  /** Stable across a rename; a name can be reused, an id cannot. */
  instanceId: string;
  zone: string;
}

/**
 * The identity a set of verified claims describes, or null.
 *
 * Null rather than a thrown error: every caller's answer to "this token does not
 * establish a node" is the same — fall back to the shared token — and an
 * exception would make that path the noisy one.
 */
export function nodeFromClaims(claims: Record<string, unknown> | null | undefined): NodeIdentity | null {
  if (!claims) return null;
  if (claims.iss !== ISSUER) return null;
  if (!ACCEPTED_NODE_AUDIENCES.includes(claims.aud as (typeof ACCEPTED_NODE_AUDIENCES)[number])) return null;

  // `format=full` is what puts this block in the payload. A token requested
  // without it is still valid, still signed by Google, and says nothing about
  // which machine — which is the entire thing being bought here, so its absence
  // is a refusal rather than a default.
  const ce = (claims.google as { compute_engine?: Record<string, unknown> } | undefined)?.compute_engine;
  if (!ce) return null;

  // An instance in ANOTHER project can ask Google for a token with our audience,
  // because an audience is a string rather than a secret. The project is what
  // makes the token ours.
  if (ce.project_id !== PROJECT) return null;

  const node = typeof ce.instance_name === "string" ? ce.instance_name : "";
  const instanceId = ce.instance_id === undefined ? "" : String(ce.instance_id);
  const zone = typeof ce.zone === "string" ? ce.zone : "";
  if (!node || !instanceId) return null;

  return { node, instanceId, zone };
}

/**
 * Google's public keys, fetched once and cached by `jose`.
 *
 * Module scope on purpose: the key set rotates on Google's clock, not ours, and
 * a per-request fetch would put an outbound call on the path of every node
 * message. `createRemoteJWKSet` handles the refresh and the cooldown.
 */
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/**
 * Verify a token's signature and return the node it names.
 *
 * The signature check comes from `jose` rather than from anything written here.
 * A hand-rolled JWT verifier is the classic place to get `alg` confusion, a
 * missing `exp`, or the wrong key wrong — and this one guards the fleet's
 * control channel.
 */
export async function verifyNodeIdentity(token: string): Promise<NodeIdentity | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: NODE_AUDIENCE,
    });
    return nodeFromClaims(payload as Record<string, unknown>);
  } catch {
    // Expired, wrong audience, bad signature, unreachable keys — all the same
    // answer to the caller, which is "this did not establish a node".
    return null;
  }
}

/**
 * How strictly a signed identity is required.
 *
 * `audit` is the rollout state and the reason this is a setting at all: nodes
 * collect a new agent on their OWN two-minute timer, so for a while some send
 * the header and some do not. Refusing early would take the fleet's secrets away
 * from every node that had not updated yet — the same shape as the incident on
 * 11 Aug, where an agent outran the route it needed and three apps failed their
 * releases.
 */
export type IdentityMode = "audit" | "enforce";

export function identityMode(env: Record<string, string | undefined>): IdentityMode {
  return env.NODE_IDENTITY === "enforce" ? "enforce" : "audit";
}

export interface IdentityCheck {
  ok: boolean;
  /**
   * Whether this passed ONLY because the mode is `audit`.
   *
   * Always present, never merely absent. A field that is sometimes undefined
   * makes `audited === false` and "there was no opinion" the same value, and the
   * whole point of this one is to tell a rollout gap apart from a real answer.
   */
  audited: boolean;
  reason?: string;
}

/**
 * Whether a request claiming to come from `claimed` may proceed.
 *
 * A MISMATCH IS NEVER MERELY AUDITED, and that distinction is the design. Audit
 * is about tokens that are ABSENT — a node that has not been updated — and never
 * about tokens that actively contradict the request. The first is a rollout in
 * progress; the second is a node claiming to be a different node, which is the
 * exact thing this mechanism was built to catch and there is no window in which
 * allowing it is the friendly choice.
 */
export function identityVerdict(
  claimed: string,
  verified: NodeIdentity | null,
  mode: IdentityMode,
): IdentityCheck {
  if (verified) {
    if (verified.node === claimed) return { ok: true, audited: false };
    return {
      ok: false,
      audited: false,
      reason: `the request says ${claimed}; the signed identity says ${verified.node}`,
    };
  }
  if (mode === "enforce") {
    return { ok: false, audited: false, reason: "no verifiable instance identity, and this control plane is enforcing" };
  }
  return { ok: true, audited: true };
}
