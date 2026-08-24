// CRUD endpoint for the per-workspace agent graph (nodes + edges); guarded by the GRAPH_ENABLED flag.
import { NextResponse } from "next/server";
import { getGraph, isGraphEnabled, saveGraph } from "@/lib/agent/graph";
import type { GraphEdge, NodePosition } from "@/lib/agent/graph";
import { createLogger } from "@/lib/infra/logger";
import { errorResponse, appErrorResponse, readJsonObject } from "@/lib/api/errorResponse";

const log = createLogger("api");

export function GET(req: Request) {
  if (!isGraphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  return NextResponse.json(getGraph());
}

export async function PUT(req: Request) {
  if (!isGraphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as {
    edges: GraphEdge[];
    positions: Record<string, NodePosition>;
  };
  const edges = body.edges ?? [];
  try {
    // Answered with the graph as stored, not just `ok`: the store mints each edge's id, so a caller
    // that kept its own would resend it and be given another one on every save.
    return NextResponse.json({ ok: true, ...saveGraph(edges, body.positions ?? {}) });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_graph_save_failed",
        outcome: "graph_updated_in_memory_only",
        err,
        route: "workspace-graph",
      },
      "failed to save workspace graph",
    );
    return errorResponse("INTERNAL_ERROR", "failed to save workspace graph", { request: req });
  }
}
