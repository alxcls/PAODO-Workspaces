// The whole-document graph write — the canvas saving edges and layout together. Owns referential
// integrity for the document, since otherwise this route is the way around connect.ts's per-edge check.
import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { saveGraph, type GraphEdge, type GraphFile, type NodePosition } from "@/lib/agent/graph";
import { getStore } from "@/lib/infra/services";

export interface SaveWorkspaceGraphInput {
  edges?: unknown;
  positions?: unknown;
}

/** Narrower than the workspace registry and the graph store: existence, and the one write. */
export interface GraphDocumentDeps {
  workspaceExists(workspaceId: string): boolean;
  save: typeof saveGraph;
}

function defaultDeps(): GraphDocumentDeps {
  return {
    workspaceExists: (workspaceId) => getStore().getWorkspace(workspaceId) !== undefined,
    save: saveGraph,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One edge, checked and passed on whole — fields this layer has no opinion about (the handles the
 * canvas recorded) belong to the editor. A missing id becomes "" rather than being refused: the store
 * mints every id it keeps, and only a string reaches the prefix check that decides if one survives.
 */
function checkedEdge(value: unknown, index: number, exists: (workspaceId: string) => boolean): GraphEdge {
  const at = (field: string) => `edges[${index}].${field}`;
  if (!isPlainObject(value)) {
    throw new AppError("INVALID_REQUEST", `edges[${index}] must be an object`, { field: `edges[${index}]` });
  }
  const source = requireNonEmptyString(value.source, at("source"));
  const target = requireNonEmptyString(value.target, at("target"));

  // Named here rather than left to the store, which explains a self-edge as "only DAGs are allowed".
  if (source === target) {
    throw new AppError("INVALID_REQUEST", "a workspace cannot call itself", { field: at("target") });
  }
  if (!exists(source)) {
    throw new AppError("NOT_FOUND", "caller workspace not found", { field: at("source") });
  }
  if (!exists(target)) {
    throw new AppError("NOT_FOUND", "callee workspace not found", { field: at("target") });
  }
  return { ...value, id: typeof value.id === "string" ? value.id : "", source, target };
}

/**
 * Replace the stored graph with the document sent. Every edge is checked before any is written, so a
 * document with one dangling end leaves the stored graph exactly as it was rather than losing an edge.
 */
export function saveWorkspaceGraph(
  input: SaveWorkspaceGraphInput,
  deps: GraphDocumentDeps = defaultDeps(),
): GraphFile {
  const submitted = input.edges ?? [];
  if (!Array.isArray(submitted)) {
    throw new AppError("INVALID_REQUEST", "edges must be an array", { field: "edges" });
  }
  // Entries go through unchecked: a cell places drives too, and one nothing references grants nothing.
  const positions = input.positions ?? {};
  if (!isPlainObject(positions)) {
    throw new AppError("INVALID_REQUEST", "positions must be an object", { field: "positions" });
  }

  const edges = submitted.map((edge, index) => checkedEdge(edge, index, deps.workspaceExists));
  return deps.save(edges, positions as Record<string, NodePosition>);
}
