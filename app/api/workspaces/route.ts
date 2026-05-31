// REST endpoint for the workspace collection.
// GET returns all workspaces; POST creates a new one with an isolated directory and starter AGENTS.md.
import { NextRequest, NextResponse } from "next/server";
import { listWorkspaces, createWorkspace } from "@/lib/infra/workspaceStore";
import { createLogger } from "@/lib/infra/logger";
import { checkRateLimit } from "@/lib/infra/rateLimit";
import { getClientIp } from "@/lib/infra/clientIp";

export async function GET() {
  const list = listWorkspaces().map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "workspaces" });
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    log.warn({ ip }, "rate limit exceeded");
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  const body = await req.json() as { name?: string };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const workspace = await createWorkspace(body.name.trim());
    return NextResponse.json(
      { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt },
      { status: 201 }
    );
  } catch (err) {
    log.error({ err, name: body.name }, "failed to create workspace");
    return NextResponse.json({ error: "failed to create workspace" }, { status: 500 });
  }
}
