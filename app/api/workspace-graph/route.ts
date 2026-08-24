// The whole agent graph (nodes + edges), guarded by the GRAPH_ENABLED flag. Translation only: the
// checks and field rules are in lib/operations/graph/save.ts, as the per-edge route's are in connect.
import { NextResponse } from "next/server";
import { getGraph, isGraphEnabled } from "@/lib/agent/graph";
import { createLogger } from "@/lib/infra/logger";
import { errorResponse, appErrorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { saveWorkspaceGraph } from "@/lib/operations/graph/save";

const log = createLogger("api");

export function GET(req: Request) {
  if (!isGraphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  return NextResponse.json(getGraph());
}

export async function PUT(req: Request) {
  if (!isGraphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  try {
    // The graph as stored, not just `ok`: the store mints the ids, so a caller keeping its own would
    // resend it and be given another on every save.
    return NextResponse.json({ ok: true, ...saveWorkspaceGraph(parsed) });
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
