// REST endpoint for a single workspace.
// GET returns its metadata; DELETE removes it from the registry and deletes its directory from disk.
import { type NextRequest, NextResponse } from "next/server";
import { getWorkspace, deleteWorkspace, renameWorkspace, setWorkspaceMaxIterations } from "@/lib/infra/workspaceStore";
import { checkRateLimit } from "@/lib/infra/rateLimit";
import { createLogger } from "@/lib/infra/logger";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id: ws.id, name: ws.name, dir: ws.dir, createdAt: ws.createdAt, maxIterations: ws.maxIterations });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    const { id } = await params;
    createLogger("api").warn({ workspaceId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const { id } = await params;
  const body = (await req.json()) as { name?: string; maxIterations?: number };

  if (body.maxIterations !== undefined) {
    const n = Math.max(1, Math.floor(Number(body.maxIterations)));
    if (!isFinite(n)) return NextResponse.json({ error: "invalid maxIterations" }, { status: 400 });
    const ok = setWorkspaceMaxIterations(id, n);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ id, maxIterations: n });
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const ok = await renameWorkspace(id, body.name);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id, name: body.name.trim() });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    const { id } = await params;
    createLogger("api").warn({ workspaceId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const { id } = await params;
  const deleted = await deleteWorkspace(id);
  return NextResponse.json({ deleted });
}
