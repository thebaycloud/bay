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
      return i.hasGrant;
    case "private":
      return false;
    default:
      return false;
  }
}
