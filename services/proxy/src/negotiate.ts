/**
 * Whether this client wants the page rather than the object.
 *
 * The test is on text/html and never on JSON, deliberately. RFC 9110 §12.1
 * describes the negotiation; the Fetch Standard decides the default, because a
 * bare fetch() sends an Accept header of two wildcards (any type, any
 * subtype) and a client that says nothing must be treated as a machine.
 */
export function wantsHtml(accept: string | undefined): boolean {
  return /text\/html/i.test(accept ?? "");
}
