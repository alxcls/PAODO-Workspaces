// One agent-call edge at a time: POST connects a caller to a callee, DELETE removes one by id. Unlike
// the sibling document route it leaves positions alone; the checks are in lib/operations/graph/connect.
import { NextResponse, type NextRequest } from "next/server";
import { isGraphEnabled } from "@/lib/agent/graph";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { connectWorkspaces, disconnectWorkspaces } from "@/lib/operations/graph/connect";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api").child({ route: "workspace-graph/edges" });

export async function POST(req: NextRequest) {
  if (!isGraphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    return NextResponse.json(connectWorkspaces(parsed), { status: 201 });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_call_connect_failed",
        outcome: "call_edge_not_persisted",
        code: "INTERNAL_ERROR",
        err,
      },
      "failed to connect workspaces",
    );
    return errorResponse("INTERNAL_ERROR", "failed to connect workspaces", { request: req });
  }
}

export async function DELETE(req: NextRequest) {
  if (!isGraphEnabled()) return errorResponse("NOT_FOUND", "Graph feature is disabled", { request: req });
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    return NextResponse.json(disconnectWorkspaces(parsed));
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_call_disconnect_failed",
        outcome: "call_edge_not_removed",
        code: "INTERNAL_ERROR",
        err,
      },
      "failed to disconnect workspaces",
    );
    return errorResponse("INTERNAL_ERROR", "failed to disconnect workspaces", { request: req });
  }
}
