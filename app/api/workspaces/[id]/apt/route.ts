export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { ensureContainer } from "@/lib/infra/containerManager";
import { aptInstall } from "@/lib/infra/aptBroker";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { packages } = body as { packages?: unknown };
  if (!Array.isArray(packages) || packages.length === 0 || packages.some((p) => typeof p !== "string")) {
    return NextResponse.json({ error: "packages must be a non-empty string array" }, { status: 400 });
  }

  await ensureContainer(ws.id, ws.dir);

  const result = await aptInstall(ws.id, packages as string[]);
  if (result.code !== 0) {
    return NextResponse.json({ error: result.stderr || "apt install failed" }, { status: 500 });
  }

  return NextResponse.json({ installed: result.installed, output: result.stdout });
}
