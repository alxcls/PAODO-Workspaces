// REST endpoint for a workspace's internet-access toggle. GET returns current state; PATCH flips it.
// PATCH also stops the running container so its network is torn down and rebuilt with the correct
// --internal flag on next use (containerManager.ts) — the toggle only becomes a real network-layer
// boundary once that happens, not merely once the setting is persisted.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { setWorkspaceInternetAccess } from "@/lib/workspace/workspaceStore";
import { setInternetAccessPolicy } from "@/lib/infra/proxy/internetAccessPolicy";
import { getContainers } from "@/lib/infra/services";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json({ enabled: ws.internetAccess });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const { enabled } = (await req.json()) as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  setWorkspaceInternetAccess(id, enabled);
  setInternetAccessPolicy(id, enabled);
  await getContainers().stop(id);

  return NextResponse.json({ ok: true });
}
