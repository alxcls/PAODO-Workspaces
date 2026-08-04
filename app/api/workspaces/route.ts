// REST endpoint for the workspace collection.
// GET returns all workspaces; POST creates a new one with an isolated directory and starter AGENTS.md.
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { workspaceNameErrorResponse } from "@/lib/api/guards";
import { createWorkspace, listWorkspaces } from "@/lib/operations/workspaces";

export async function GET() {
  return NextResponse.json(listWorkspaces());
}

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "workspaces" });
  const body = (await req.json()) as { name?: string };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await createWorkspace({ name: body.name }), { status: 201 });
  } catch (err) {
    const nameError = workspaceNameErrorResponse(err);
    if (nameError) return nameError;
    log.error(
      { event: "workspace_create_failed", outcome: "workspace_not_created", err, name: body.name },
      "failed to create workspace",
    );
    return NextResponse.json({ error: "failed to create workspace" }, { status: 500 });
  }
}
