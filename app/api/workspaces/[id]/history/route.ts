// Versioning history for a workspace: the run/baseline commit log as JSON.
import { NextResponse } from "next/server";
import { getVersioning } from "@/lib/infra/services";
import { requireWorkspace } from "@/lib/api/guards";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  // Pre-existing workspaces with no versioning repo yet return [] (history() is graceful).
  const commits = await getVersioning().history(ws.id, ws.dir);
  return NextResponse.json({ commits });
}
