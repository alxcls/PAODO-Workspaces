// Translates between the four API payloads and what React Flow renders. Pure — no fetching, no
// React — so placement and edge-shaping rules are readable (and testable) in one place.
import type { Edge, Node } from "@xyflow/react";
import type { CellPosition } from "@/lib/agent/graph";
import { createCellAllocator, readStoredPosition, toCell, toPixels } from "./grid";
import { WORKSPACE_BOTTOM_HANDLE, WORKSPACE_TOP_HANDLE, normalizeWorkspaceIncomingHandle } from "./handles";
import { DRIVE_EDGE_STYLE, EDGE_STYLE } from "./edgeStyles";
import { DRIVE_KIND, type GraphNodeData } from "./types";
import type { DriveConnectionItem, DriveItem, GraphDocumentPayload, StoredGraph, WorkspaceItem } from "./graphApi";

const graphNode = (id: string, type: string, cell: CellPosition, data: GraphNodeData): Node => ({
  id,
  type,
  deletable: false,
  position: toPixels(cell),
  data: { ...data },
});

export const driveNode = (drive: DriveItem, cell: CellPosition): Node =>
  graphNode(drive.id, "drive", cell, { label: drive.name, description: drive.description, kind: DRIVE_KIND });

const workspaceNode = (workspace: WorkspaceItem, cell: CellPosition): Node =>
  graphNode(workspace.id, "workspace", cell, { label: workspace.name, description: workspace.description ?? "" });

/** A node the editor has never placed gets the first free cell rather than a slot derived from its
 *  index in the response — that index shifts whenever a sibling is added. */
export function buildNodes({ workspaces, drives, graph }: Omit<GraphDocumentPayload, "connections">): Node[] {
  const placed = new Map<string, CellPosition>();
  for (const [id, stored] of Object.entries(graph.positions ?? {})) {
    const cell = readStoredPosition(stored);
    if (cell) placed.set(id, cell);
  }
  const allocate = createCellAllocator(placed.values());
  const cellOf = (id: string) => placed.get(id) ?? allocate();
  return [
    ...workspaces.map((workspace) => workspaceNode(workspace, cellOf(workspace.id))),
    ...drives.map((drive) => driveNode(drive, cellOf(drive.id))),
  ];
}

/** The next cell nobody on the canvas holds — where a node created from the toolbar lands. */
export const nextFreeCell = (nodes: Node[]): CellPosition =>
  createCellAllocator(nodes.map((node) => toCell(node.position)))();

export function buildEdges(
  graph: StoredGraph,
  connections: DriveConnectionItem[],
  workspaces: WorkspaceItem[],
): Edge[] {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const workspaceEdges: Edge[] = (graph.edges ?? []).map((edge) => ({
    ...edge,
    sourceHandle: workspaceIds.has(edge.source) ? WORKSPACE_BOTTOM_HANDLE : edge.sourceHandle,
    targetHandle: workspaceIds.has(edge.target) ? WORKSPACE_TOP_HANDLE : edge.targetHandle,
    ...EDGE_STYLE,
  }));
  const driveEdges: Edge[] = connections.map((connection) => ({
    id: connection.id,
    source: connection.driveId,
    target: connection.workspaceId,
    sourceHandle: connection.sourceHandle,
    targetHandle: normalizeWorkspaceIncomingHandle(connection.targetHandle),
    ...DRIVE_EDGE_STYLE,
  }));
  return [...workspaceEdges, ...driveEdges];
}

/** What the canvas sends back to the server: one cell per node, keyed by id. */
export function storedPositions(nodes: Node[]): Record<string, CellPosition> {
  const positions: Record<string, CellPosition> = {};
  for (const node of nodes) positions[node.id] = toCell(node.position);
  return positions;
}
