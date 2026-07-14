// REST endpoint for the workspace collection.
// GET returns all workspaces; POST creates a new one with an isolated directory and starter AGENTS.md.
import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
import { createLogger } from "@/lib/infra/logger";
import { rateLimited } from "@/lib/api/guards";

export async function GET() {
  const list = getStore().listWorkspaces().map(({ id, name, createdAt, description }) => ({ id, name, createdAt, description: description ?? "" }));
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "workspaces" });
  const limited = rateLimited(req, { logContext: { route: "workspaces" } });
  if (limited) return limited;

  const body = await req.json() as { name?: string };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const workspace = await getStore().createWorkspace(body.name.trim());
    return NextResponse.json(
      { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt },
      { status: 201 }
    );
  } catch (err) {
    log.error({ err, name: body.name }, "failed to create workspace");
    return NextResponse.json({ error: "failed to create workspace" }, { status: 500 });
  }
}
