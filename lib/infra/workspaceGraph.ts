// Persists the directed workspace connection graph to data/workspace-graph.json.
// Edges flow from caller (source) → callee (target), enforcing a DAG where only
// connected workspaces can invoke each other via the call_agent tool.
import path from "path";
import fs from "fs";
import { WORKSPACES_ROOT } from "./workspaceStore";

export interface GraphEdge {
  id: string;
  source: string; // caller workspace ID
  target: string; // callee workspace ID
}

interface GraphFile {
  edges: GraphEdge[];
  positions: Record<string, { x: number; y: number }>;
}

const GRAPH_FILE = path.join(WORKSPACES_ROOT, "workspace-graph.json");

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

export function saveGraph(
  edges: GraphEdge[],
  positions: Record<string, { x: number; y: number }>
): void {
  cache = { edges, positions };
  fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
  fs.writeFileSync(GRAPH_FILE, JSON.stringify(cache, null, 2));
}

export function canCall(fromId: string, toId: string): boolean {
  return cache.edges.some((e) => e.source === fromId && e.target === toId);
}

export function getCallees(fromId: string): string[] {
  return cache.edges.filter((e) => e.source === fromId).map((e) => e.target);
}
