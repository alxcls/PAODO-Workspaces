// CRUD endpoint for the per-workspace agent graph (nodes + edges); guarded by the GRAPH_ENABLED flag.
import { NextResponse } from "next/server";
import { getGraph, saveGraph } from "@/lib/agent/network/graph";
import type { GraphEdge } from "@/lib/agent/network/graph";
import { createLogger } from "@/lib/infra/logger";
import { errorResponse, appErrorResponse } from "@/lib/api/errorResponse";

const log = createLogger("api");

function graphEnabled() {
  return process.env.GRAPH_ENABLED !== "false";
}

export function GET(req: Request) {
  if (!graphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  return NextResponse.json(getGraph());
}

export async function PUT(req: Request) {
  if (!graphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  const body = (await req.json()) as {
    edges: GraphEdge[];
    positions: Record<string, { x: number; y: number }>;
  };
  const edges = body.edges ?? [];
  try {
    saveGraph(edges, body.positions ?? {});
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
  return NextResponse.json({ ok: true });
}
