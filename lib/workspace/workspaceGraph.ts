// Persists the directed workspace connection graph to data/.workspace-graph.json.
// Edges flow from caller (source) → callee (target), enforcing a DAG where only
// connected workspaces can invoke each other via the call_agent tool.
import path from "path";
import fs from "fs";
import { WORKSPACES_ROOT } from "../infra/paths";
import { atomicSaveJson } from "../infra/jsonPersist";
import { createLogger } from "../infra/logger";

const log = createLogger("workspaceGraph");

export interface GraphEdge {
  id: string;
  source: string; // caller workspace ID
  target: string; // callee workspace ID
}

interface GraphFile {
  edges: GraphEdge[];
  positions: Record<string, { x: number; y: number }>;
}

const GRAPH_FILE = path.join(WORKSPACES_ROOT, ".workspace-graph.json");

let cache: GraphFile = { edges: [], positions: {} };

function load(): void {
  try {
    cache = JSON.parse(fs.readFileSync(GRAPH_FILE, "utf-8")) as GraphFile;
  } catch {
    // File doesn't exist yet — start with empty graph
  }
}

load();

export function getGraph(): GraphFile {
  return cache;
}

function hasCycle(edges: GraphEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(n: string): boolean {
    visited.add(n); stack.add(n);
    for (const m of adj.get(n) ?? []) {
      if (stack.has(m) || (!visited.has(m) && dfs(m))) return true;
    }
    stack.delete(n);
    return false;
  }
  for (const n of adj.keys()) if (!visited.has(n) && dfs(n)) return true;
  return false;
}

export function saveGraph(
  edges: GraphEdge[],
  positions: Record<string, { x: number; y: number }>
): void {
  if (hasCycle(edges)) {
    log.warn({ edgeCount: edges.length }, "saveGraph rejected — cycle detected");
    throw new Error("Graph contains a cycle — only DAGs are allowed.");
  }
  cache = { edges, positions };
  atomicSaveJson(GRAPH_FILE, cache);
}

export function canCall(fromId: string, toId: string): boolean {
  return cache.edges.some((e) => e.source === fromId && e.target === toId);
}

export function getCallees(fromId: string): string[] {
  return cache.edges.filter((e) => e.source === fromId).map((e) => e.target);
}
