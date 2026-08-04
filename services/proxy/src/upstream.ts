/**
 * Is this upstream one of our Cloud Run services, or a node in the fleet?
 *
 * Two credentials hang off the answer, in opposite directions, and crossing them
 * is a bug either way:
 *
 * - A sealed Cloud Run app needs an ID token in `x-serverless-authorization`.
 *   Sending one to a fleet node puts a Google-signed assertion of this service
 *   account's identity on a plaintext hop over the public internet, where it
 *   proves nothing and discloses something.
 * - A fleet node needs `x-supersonic-edge`, because its router trusts a
 *   client-supplied slug header and its load balancer answers the open internet.
 *   Sending that secret to a Cloud Run app hands it to a tenant, who could then
 *   reach every app on every node.
 *
 * The suffix is checked on the parsed hostname, never on the raw string: a URL
 * can carry `run.app` in its path or in a subdomain of somebody else's domain.
 * The hostname is normalized before the check — one trailing dot stripped
 * (`a.run.app.` is a valid absolute FQDN for the same host `a.run.app` names;
 * WHATWG `URL` preserves it rather than stripping it) and the bare apex
 * `run.app` accepted outright — because either one, left unmatched, comes out
 * `false`, and `false` is the branch at the forward.ts call site that sends
 * the fleet's edge secret. A Cloud Run host that fails this check doesn't
 * fail closed; it fails to the OTHER credential, straight to a tenant.
 *
 * An unparseable base also returns `false`, for the same reason: there is no
 * third "send nothing" outcome here, only "Cloud Run" or "fleet". This
 * function does not make that case safe by itself — what does is that
 * forward.ts builds `new URL(req.url, targetBase)` before this predicate ever
 * runs and throws on a malformed base first, so in practice this is never
 * called with one. That is a property of call-site ordering, not of this
 * predicate; if that ordering ever changes, this stops being true.
 */
export function isCloudRunTarget(targetBase: string): boolean {
  try {
    const hostname = new URL(targetBase).hostname.replace(/\.$/, "");
    return hostname === "run.app" || hostname.endsWith(".run.app");
  } catch {
    return false;
  }
}
