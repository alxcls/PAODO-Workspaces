// REST endpoint for the workspace collection.
// GET returns all workspaces; POST creates a new one with an isolated directory and starter AGENTS.md.
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createWorkspace } from "@/lib/operations/workspace/create";
import { listWorkspaces } from "@/lib/operations/workspace/read";

export async function GET() {
  return NextResponse.json(listWorkspaces());
}

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "workspaces" });
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) {
    return errorResponse("INVALID_REQUEST", "name is required", {
      request: req,
      details: { field: "name" },
    });
  }
  try {
    return NextResponse.json(await createWorkspace({ name: body.name }), { status: 201 });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_create_failed",
        outcome: "workspace_not_created",
        code: "INTERNAL_ERROR",
        err,
        name: body.name,
      },
      "failed to create workspace",
    );
    return errorResponse("INTERNAL_ERROR", "failed to create workspace", { request: req });
  }
}
