// What a dragged link is allowed to become. Deciding and applying are split so the rules stay pure:
// every rejection message and every edge shape is here, and the hook only routes the outcome.
import { addEdge, type Connection, type Edge } from "@xyflow/react";
import { normalizeWorkspaceIncomingHandle } from "./handles";
import { DRIVE_EDGE_STYLE, EDGE_STYLE } from "./edgeStyles";
import { isDriveEdge } from "./types";

export type ConnectionOutcome =
  | { kind: "ignored" }
  | { kind: "rejected"; message: string }
  | { kind: "agent-link"; connection: Connection }
  | { kind: "drive-link"; edge: Edge; replaces?: string };

interface ConnectionContext {
  driveIds: Set<string>;
  edges: Edge[];
}

/** A drive link is one edge per drive/workspace pair: re-dragging it moves its handles in place
 *  instead of stacking a second link on the same pair. */
function resolveDriveLink(connection: Connection, sourceIsDrive: boolean, edges: Edge[]): ConnectionOutcome {
  const driveId = sourceIsDrive ? connection.source : connection.target;
  const workspaceId = sourceIsDrive ? connection.target : connection.source;
  const sourceHandle = sourceIsDrive ? connection.sourceHandle : connection.targetHandle;
  const targetHandle = normalizeWorkspaceIncomingHandle(
    sourceIsDrive ? connection.targetHandle : connection.sourceHandle,
  );
  const existing = edges.find((edge) => isDriveEdge(edge) && edge.source === driveId && edge.target === workspaceId);
  if (existing && existing.sourceHandle === sourceHandle && existing.targetHandle === targetHandle) {
    return { kind: "ignored" };
  }
  return {
    kind: "drive-link",
    replaces: existing?.id,
    edge: {
      id: existing?.id ?? crypto.randomUUID(),
      source: driveId,
      target: workspaceId,
      sourceHandle,
      targetHandle,
      ...DRIVE_EDGE_STYLE,
    },
  };
}

/** Agent calls flow one way down the graph; a link back up would let two agents call each other. */
function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (isDriveEdge(edge)) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge.target);
  }
  const visited = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === source) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) queue.push(next);
  }
  return false;
}

export function resolveConnection(connection: Connection, { driveIds, edges }: ConnectionContext): ConnectionOutcome {
  if (!connection.source || !connection.target) return { kind: "ignored" };
  if (connection.source === connection.target) {
    return { kind: "rejected", message: "A node cannot connect to itself." };
  }
  const sourceIsDrive = driveIds.has(connection.source);
  const targetIsDrive = driveIds.has(connection.target);
  if (sourceIsDrive && targetIsDrive) {
    return { kind: "rejected", message: "Drives can only connect to workspaces." };
  }
  if (sourceIsDrive || targetIsDrive) return resolveDriveLink(connection, sourceIsDrive, edges);
  if (wouldCreateCycle(edges, connection.source, connection.target)) {
    return { kind: "rejected", message: "Loop detected — agents cannot call back up the chain." };
  }
  return { kind: "agent-link", connection };
}

/** Fold an accepted outcome into the edge list. */
export function applyConnection(outcome: ConnectionOutcome, edges: Edge[]): Edge[] {
  if (outcome.kind === "agent-link") return addEdge({ ...outcome.connection, ...EDGE_STYLE }, edges);
  if (outcome.kind !== "drive-link") return edges;
  const { edge, replaces } = outcome;
  return replaces ? edges.map((candidate) => (candidate.id === replaces ? edge : candidate)) : [...edges, edge];
}
