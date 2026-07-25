export interface AccessInput {
  app: {
    id: string;
    owner_id: string;
    workspace_id: string;
    visibility: "private" | "shared" | "workspace";
  };
  visitor: { userId: string; email: string };
  visitorWorkspaceId: string | null;
  hasGrant: boolean;
}

/**
 * The whole access model. Pure: every input is already resolved by the caller.
 * Deny is the default — every allow path must be explicit.
 */
export function decideAccess(i: AccessInput): boolean {
  if (i.visitor.userId === i.app.owner_id) return true;

  switch (i.app.visibility) {
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
