// Handle ids for the workspace node's two connection points, and the rule for which one an
// incoming link snaps to. Shared because both sides need to agree: WorkspaceNode renders the
// handles, while the editor normalizes whatever handle id comes back from the store or from a
// drag before it touches an edge.

export const WORKSPACE_TOP_HANDLE = "workspace-target-top";
export const WORKSPACE_BOTTOM_HANDLE = "workspace-source-bottom";

const WORKSPACE_INCOMING_HANDLES = new Set<string>([WORKSPACE_TOP_HANDLE, WORKSPACE_BOTTOM_HANDLE]);

/** Map an incoming link's handle onto one the workspace node actually renders. Links saved before
 *  the bottom handle became a source still carry the old id, and a loose-mode drag can hand back
 *  anything at all; both resolve to the top handle unless they name a known one. */
export function normalizeWorkspaceIncomingHandle(handle?: string | null): string {
  if (handle === "workspace-target-bottom") return WORKSPACE_BOTTOM_HANDLE;
  return handle && WORKSPACE_INCOMING_HANDLES.has(handle) ? handle : WORKSPACE_TOP_HANDLE;
}
