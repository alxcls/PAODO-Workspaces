// Persists the directed workspace connection graph to data/.workspace-graph.json. Edges flow from
// caller (source) → callee (target): a DAG where only connected workspaces can call_agent each other.
import path from "path";
import { WORKSPACES_ROOT } from "../infra/paths";
import { atomicSaveJson, readJson } from "../infra/jsonPersist";
import { globalSingleton } from "../infra/globalSingleton";
import { createLogger } from "../infra/logger";
import { AppError } from "../errors/appError";
import { connectionKind, mintConnectionId } from "../connections/ids";

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

export interface GraphFile {
  edges: GraphEdge[];
  positions: Record<string, NodePosition>;
}

const GRAPH_FILE = path.join(WORKSPACES_ROOT, ".workspace-graph.json");

// On a shared global holder, not a module-level `let`, so every Next.js module instance reads one
// cache — otherwise an edge added via the API stays invisible to call-gating until restart.
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

// Ids are this store's to give. An id survives only if the store issued it and nothing earlier in the
// same save claimed it: the `call_` prefix is public, so recognising it would let a caller collide.
function minted(edges: GraphEdge[]): GraphEdge[] {
  const issued = new Set(state.graph.edges.map((edge) => edge.id));
  const claimed = new Set<string>();
  return edges.map((edge) => {
    const keep = connectionKind(edge.id) === "call" && issued.has(edge.id) && !claimed.has(edge.id);
    const id = keep ? edge.id : mintConnectionId("call");
    claimed.add(id);
    return keep ? edge : { ...edge, id };
  });
}

// Not logged: the graph editor lets a user draw a cycle, and rejecting it is the feature working.
// The route turns this into a 400 the user sees and acts on — nothing for an operator to do.
function refuseCycle(edges: GraphEdge[]): void {
  if (hasCycle(edges)) {
    throw new AppError("INVALID_REQUEST", "Graph contains a cycle — only DAGs are allowed.");
  }
}

/** Answers with the graph as stored — the edges in the order they were sent, under the ids they were
 *  given — so the caller that drew them can adopt those ids rather than resend its own next time. */
export function saveGraph(edges: GraphEdge[], positions: Record<string, NodePosition>): GraphFile {
  refuseCycle(edges);
  state.graph = { edges: minted(edges), positions };
  atomicSaveJson(GRAPH_FILE, state.graph);
  return state.graph;
}

/**
 * One edge, added without the caller holding an opinion about layout: `positions` is carried through
 * from what is already stored, so a client that has no canvas cannot erase one. Nothing awaits between
 * that read and the write, so the editor's own save cannot interleave with it.
 *
 * An already-connected pair answers with the edge it already has. A second parallel edge would say
 * nothing the first does not, and would leave the caller two ids for one capability.
 */
export function addCallEdge(source: string, target: string): GraphEdge {
  const existing = state.graph.edges.find((e) => e.source === source && e.target === target);
  if (existing) return existing;
  const edge: GraphEdge = { id: mintConnectionId("call"), source, target };
  refuseCycle([...state.graph.edges, edge]);
  state.graph = { edges: [...state.graph.edges, edge], positions: state.graph.positions };
  atomicSaveJson(GRAPH_FILE, state.graph);
  return edge;
}

/** False for an id this graph does not hold, the answer disconnectDrive gives a link already gone. */
export function removeCallEdge(connectionId: string): boolean {
  const edges = state.graph.edges.filter((e) => e.id !== connectionId);
  if (edges.length === state.graph.edges.length) return false;
  state.graph = { edges, positions: state.graph.positions };
  atomicSaveJson(GRAPH_FILE, state.graph);
  return true;
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
  // Called mid-cascade by DELETE /api/workspaces/[id]: throwing would abort the container, file and
  // key cleanup that follows. A stale edge is cheap to live with, an orphaned container is not.
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
