// Persists the directed workspace connection graph to data/.workspace-graph.json.
// Edges flow from caller (source) → callee (target), enforcing a DAG where only
// connected workspaces can invoke each other via the call_agent tool.
import path from "path";
import { WORKSPACES_ROOT } from "../../infra/paths";
import { atomicSaveJson, readJson } from "../../infra/jsonPersist";
import { globalSingleton } from "../../infra/globalSingleton";
import { createLogger } from "../../infra/logger";
import { AppError } from "../../errors/appError";

const log = createLogger("workspaceGraph");

export interface GraphEdge {
  id: string;
  source: string; // caller workspace ID
  target: string; // callee workspace ID
}

/** A node's cell on the editor lattice. Integers, not pixels: the canvas is the only thing that
 *  knows how large a cell is, so nothing outside it has to reason in geometry to place a node. */
export interface CellPosition {
  col: number;
  row: number;
}

/** Graphs saved before the lattice hold raw pixels. The editor reads either shape and the next
 *  save rewrites the file in cells, so this union narrows on its own over time. */
export type NodePosition = CellPosition | { x: number; y: number };

interface GraphFile {
  edges: GraphEdge[];
  positions: Record<string, NodePosition>;
}

const GRAPH_FILE = path.join(WORKSPACES_ROOT, ".workspace-graph.json");

// Held on a shared global holder (not a module-level `let`) so every Next.js module instance reads
// and writes the same cache — otherwise an edge added via the API would be invisible to the agent's
// call-gating until restart. Reassign `state.graph` on writes; the holder object is the stable ref.
const state = globalSingleton("workspaceGraph", () => ({
  graph: readJson<GraphFile>(GRAPH_FILE, { edges: [], positions: {} }),
}));

export function getGraph(): GraphFile {
  return state.graph;
}

function hasCycle(edges: GraphEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(n: string): boolean {
    visited.add(n);
    stack.add(n);
    for (const m of adj.get(n) ?? []) {
      if (stack.has(m) || (!visited.has(m) && dfs(m))) return true;
    }
    stack.delete(n);
    return false;
  }
  for (const n of adj.keys()) if (!visited.has(n) && dfs(n)) return true;
  return false;
}

export function saveGraph(edges: GraphEdge[], positions: Record<string, NodePosition>): void {
  // Not logged: the graph editor lets a user draw a cycle, and rejecting it is the feature working.
  // The route turns this into a 400 the user sees and acts on — nothing for an operator to do.
  if (hasCycle(edges)) {
    throw new AppError("INVALID_REQUEST", "Graph contains a cycle — only DAGs are allowed.");
  }
  state.graph = { edges, positions };
  atomicSaveJson(GRAPH_FILE, state.graph);
}

export function canCall(fromId: string, toId: string): boolean {
  return state.graph.edges.some((e) => e.source === fromId && e.target === toId);
}

export function getCallees(fromId: string): string[] {
  return state.graph.edges.filter((e) => e.source === fromId).map((e) => e.target);
}

// True when this workspace can call another — i.e. it is the source of an edge.
// Gates the agent_call/list_agents tools so a pure callee never receives them.
export function isCaller(workspaceId: string): boolean {
  return state.graph.edges.some((e) => e.source === workspaceId);
}

/** Remove all edges and the position node for a deleted workspace. */
export function removeWorkspaceFromGraph(workspaceId: string): void {
  const { graph } = state;
  const edges = graph.edges.filter((e) => e.source !== workspaceId && e.target !== workspaceId);
  const positions = { ...graph.positions };
  delete positions[workspaceId];
  if (edges.length === graph.edges.length && !(workspaceId in graph.positions)) return;
  state.graph = { edges, positions };
  // Called mid-cascade by DELETE /api/workspaces/[id]: the registry entry is already gone, and the
  // container, files, git repo and API key are cleaned up after this returns. Throwing would abort
  // that cleanup and orphan all of it, so a failed write is logged and swallowed — a stale edge is
  // cheap to live with, an orphaned container is not. saveGraph still throws; its route handles it.
  try {
    atomicSaveJson(GRAPH_FILE, state.graph);
  } catch (err) {
    log.error(
      {
        event: "workspace_graph_cleanup_persist_failed",
        outcome: "stale_graph_may_remain",
        err,
        workspaceId,
        filePath: GRAPH_FILE,
      },
      "failed to save workspace graph after workspace removal",
    );
  }
}
