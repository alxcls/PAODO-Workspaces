// Workspace→workspace agent-call use cases, the sibling of drives/connect.ts. An edge is meaningful
// only while both ends exist, and it flows caller → callee, so refusals name the two ends apart.
import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { addCallEdge, removeCallEdge, type GraphEdge } from "@/lib/agent/graph";
import { getStore } from "@/lib/infra/services";
import { connectionKind } from "@/lib/connections/ids";

export interface ConnectWorkspacesInput {
  source?: unknown;
  target?: unknown;
}

export interface DisconnectWorkspacesInput {
  connectionId?: unknown;
}

export interface DisconnectWorkspacesResult {
  deleted: boolean;
}

/** Narrower than the workspace store and the graph store: existence, and the two writes. */
export interface WorkspaceCallDeps {
  workspaceExists(workspaceId: string): boolean;
  connect: typeof addCallEdge;
  disconnect: typeof removeCallEdge;
}

function defaultDeps(): WorkspaceCallDeps {
  return {
    workspaceExists: (workspaceId) => getStore().getWorkspace(workspaceId) !== undefined,
    connect: addCallEdge,
    disconnect: removeCallEdge,
  };
}

/**
 * Let one workspace delegate to another. An already-connected pair is not an error — the store answers
 * with the edge it has — so a caller can ask for the state it wants without tracking the id.
 */
export function connectWorkspaces(input: ConnectWorkspacesInput, deps: WorkspaceCallDeps = defaultDeps()): GraphEdge {
  const source = requireNonEmptyString(input.source, "source");
  const target = requireNonEmptyString(input.target, "target");

  // Named here rather than left to the store, which explains a self-edge as "only DAGs are allowed".
  if (source === target) {
    throw new AppError("INVALID_REQUEST", "a workspace cannot call itself", { field: "target" });
  }
  if (!deps.workspaceExists(source)) {
    throw new AppError("NOT_FOUND", "caller workspace not found", { field: "source" });
  }
  if (!deps.workspaceExists(target)) {
    throw new AppError("NOT_FOUND", "callee workspace not found", { field: "target" });
  }

  return deps.connect(source, target);
}

/**
 * Remove one edge. An unknown id reports `deleted: false` rather than raising: the state the caller
 * asked for holds either way, and a workspace deleted meanwhile has already dropped its edges.
 */
export function disconnectWorkspaces(
  input: DisconnectWorkspacesInput,
  deps: WorkspaceCallDeps = defaultDeps(),
): DisconnectWorkspacesResult {
  const connectionId = requireNonEmptyString(input.connectionId, "connectionId");
  // A drive link's id is refused by name: `deleted: false` is true of every string, so it would tell a
  // caller holding the wrong id nothing at all.
  if (connectionKind(connectionId) !== "call") {
    throw new AppError("INVALID_REQUEST", "connectionId must be an agent call id, which starts with call_", {
      field: "connectionId",
    });
  }
  return { deleted: deps.disconnect(connectionId) };
}
