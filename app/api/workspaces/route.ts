// REST endpoint for the workspace collection.
// GET returns all workspaces; POST creates a new one with an isolated directory and starter AGENTS.md.
import { type NextRequest, NextResponse } from "next/server";
import { listWorkspaces, createWorkspace } from "@/lib/infra/workspaceStore";
import { checkRateLimit } from "@/lib/infra/rateLimit";

export async function GET() {
  const list = listWorkspaces().map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  const body = await req.json() as { name?: string };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const workspace = await createWorkspace(body.name.trim());
  return NextResponse.json(
    { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt },
    { status: 201 }
  );
}
