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
 * An unparseable base returns false, so the failure mode is "no secret sent"
 * rather than "secret sent to something we could not identify".
 */
export function isCloudRunTarget(targetBase: string): boolean {
  try {
    return new URL(targetBase).hostname.endsWith(".run.app");
  } catch {
    return false;
  }
}
