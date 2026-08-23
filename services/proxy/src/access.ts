export type Visibility = "private" | "shared" | "workspace" | "public";

export interface AccessInput {
  app: {
    id: string;
    owner_id: string;
    workspace_id: string;
    visibility: Visibility;
  };
  visitor: { userId: string; email: string };
  visitorWorkspaceId: string | null;
  hasGrant: boolean;
  /**
   * The app carries a rule for the domain this visitor's address is on —
   * "anyone at luwo.ai". Resolved by the caller with SQL equality, never a
   * suffix test: a rule for luwo.ai must not admit evil-luwo.ai, which anyone
   * can register.
   */
  domainRuleMatches: boolean;
  /**
   * The identity provider PROVED this address belongs to this visitor.
   *
   * Signing up with a password asks for an address and never checks it, so
   * without this a rule for luwo.ai would admit anyone who typed a luwo.ai
   * address into our own signup form — the rule would be public with extra
   * steps. Being invited by name is unaffected: there the owner named the
   * address, so nothing has to be proven to us.
   */
  visitorEmailVerified: boolean;
}

/**
 * The whole access model. Pure: every input is already resolved by the caller.
 * Deny is the default — every allow path must be explicit.
 *
 * Note: "public" is also handled earlier in index.ts (before the sign-in check),
 * so an anonymous visitor never reaches here. It stays in the switch so an
 * authenticated visitor to a public app is allowed too.
 */
export function decideAccess(i: AccessInput): boolean {
  if (i.visitor.userId === i.app.owner_id) return true;

  switch (i.app.visibility) {
    case "public":
      return true;
    case "workspace":
      return i.visitorWorkspaceId !== null && i.visitorWorkspaceId === i.app.workspace_id;
    case "shared":
      return i.hasGrant || (i.domainRuleMatches && i.visitorEmailVerified);
    case "private":
      return false;
    default:
      return false;
  }
}

/**
 * The domain an address delivers to, or "" if it is not one address.
 *
 * A copy of `domainOf` in the control plane's lib/workspace.ts, and it must stay
 * one: reading the LAST field instead would make `boris@luwo.ai@evil.com` look
 * like luwo.ai while mail routes to evil.com — enough to satisfy a domain rule
 * for a company the visitor has nothing to do with. Anything that is not exactly
 * local@domain is refused, and every caller reads "" as "no domain".
 */
export function domainOf(email: string): string {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return "";
  const [local, domain] = parts;
  if (!local || !domain) return "";
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return "";
  return domain;
}
