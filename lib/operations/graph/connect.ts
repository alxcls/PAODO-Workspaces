// Workspace→workspace agent-call use cases.
//
// The sibling of lib/operations/drives/connect.ts, and it owns the same rule for the same reason: an
// edge names two workspaces and is only meaningful while both exist, which the graph store cannot
// check because it holds edges and knows nothing about the workspace registry. A dangling edge is not
// a harmless row — canCall and isCaller project these into what an agent may delegate to.
//
// What is different is direction. A drive link is a bipartite pair with no order; an edge here flows
// caller → callee and grants a capability one way, so the two ends are named apart in every refusal.
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
 * Let one workspace delegate to another. Connecting an already-connected pair is deliberately not an
 * error — the store answers with the edge it already has — so a caller that lost track of an id can
 * ask for the state it wants rather than having to know whether it is already established.
 */
export function connectWorkspaces(input: ConnectWorkspacesInput, deps: WorkspaceCallDeps = defaultDeps()): GraphEdge {
  const source = requireNonEmptyString(input.source, "source");
  const target = requireNonEmptyString(input.target, "target");

  // Named here rather than left to the store's cycle check, which is right about a self-edge and
  // explains it as "only DAGs are allowed" — true, and no help to whoever passed one id twice.
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
 * Remove one edge. An unknown id reports `deleted: false` rather than raising: the caller asked for a
 * state this leaves established, and a workspace deleted meanwhile has already dropped its edges.
 */
export function disconnectWorkspaces(
  input: DisconnectWorkspacesInput,
  deps: WorkspaceCallDeps = defaultDeps(),
): DisconnectWorkspacesResult {
  const connectionId = requireNonEmptyString(input.connectionId, "connectionId");
  // A drive link's id, or neither graph's, is refused by name. `deleted: false` is true of every string
  // ever sent, so it tells a caller holding the wrong id nothing at all.
  if (connectionKind(connectionId) !== "call") {
    throw new AppError("INVALID_REQUEST", "connectionId must be an agent call id, which starts with call_", {
      field: "connectionId",
    });
  }
  return { deleted: deps.disconnect(connectionId) };
}
