// Every HTTP call the graph editor makes. URLs, payload shapes and failure messages live here, so
// the state hooks above compose named operations instead of carrying fetch plumbing.
import type { CellPosition, GraphEdge, NodePosition } from "@/lib/agent/graph";
import { readApiError } from "@/lib/client/apiError";

export interface WorkspaceItem {
  id: string;
  name: string;
  description?: string;
}

export interface DriveItem {
  id: string;
  name: string;
  description?: string;
}

export interface DriveConnectionItem {
  id: string;
  driveId: string;
  workspaceId: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** Handles are re-derived on load, but graphs saved before that was true may still carry them. */
export interface StoredGraphEdge extends GraphEdge {
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface StoredGraph {
  edges: StoredGraphEdge[];
  positions: Record<string, NodePosition>;
}

export interface GraphDocumentPayload {
  workspaces: WorkspaceItem[];
  graph: StoredGraph;
  drives: DriveItem[];
  connections: DriveConnectionItem[];
}

/** The graph API is behind the GRAPH_ENABLED flag; with it off the editor has nothing to edit and
 *  the caller redirects away rather than showing an error. */
export class GraphDisabledError extends Error {
  constructor() {
    super("graph-disabled");
    this.name = "GraphDisabledError";
  }
}

const FAIL_LINKS = "Failed to save drive links";
const JSON_HEADERS = { "Content-Type": "application/json" };

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

/** Fails with the server's own message when it sends one; `fallback` covers a non-JSON response. */
async function send(url: string, init: RequestInit, fallback: string): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error((await readApiError(response, fallback)).error);
  return response;
}

/** Drives and their links are optional context: the graph still renders without them. */
const optional = <T>(url: string, empty: T): Promise<T> =>
  fetch(url).then((response) => (response.ok ? (response.json() as Promise<T>) : empty));

export function fetchGraphDocument(): Promise<GraphDocumentPayload> {
  return Promise.all([
    fetch("/api/workspaces").then((response) => response.json() as Promise<WorkspaceItem[]>),
    fetch("/api/workspace-graph").then((response) => {
      if (!response.ok) throw new GraphDisabledError();
      return response.json() as Promise<StoredGraph>;
    }),
    optional<DriveItem[]>("/api/drives", []),
    optional<DriveConnectionItem[]>("/api/drive-connections", []),
  ]).then(([workspaces, graph, drives, connections]) => ({ workspaces, graph, drives, connections }));
}

export async function saveGraph(edges: GraphEdge[], positions: Record<string, CellPosition>): Promise<void> {
  const response = await fetch("/api/workspace-graph", jsonBody("PUT", { edges, positions }));
  if (!response.ok) throw new Error((await readApiError(response, `Save failed (${response.status})`)).error);
}

export async function createDrive(name: string, description?: string): Promise<DriveItem> {
  const response = await send("/api/drives", jsonBody("POST", { name, description }), "Create failed");
  return response.json() as Promise<DriveItem>;
}

export async function deleteDrive(id: string, label: string): Promise<void> {
  await send(`/api/drives/${id}`, { method: "DELETE" }, `Failed to delete ${label}`);
}

export type DriveConnectionInput = Omit<DriveConnectionItem, "id">;

export async function createDriveConnection(input: DriveConnectionInput): Promise<DriveConnectionItem> {
  const response = await send("/api/drive-connections", jsonBody("POST", input), FAIL_LINKS);
  return response.json() as Promise<DriveConnectionItem>;
}

export async function deleteDriveConnection(connectionId: string): Promise<void> {
  await send("/api/drive-connections", jsonBody("DELETE", { connectionId }), FAIL_LINKS);
}
