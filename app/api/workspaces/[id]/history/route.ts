// Versioning history for a workspace: the run/baseline commit log as JSON.
import { NextResponse } from "next/server";
import { getStore, getVersioning } from "@/lib/infra/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Pre-existing workspaces with no versioning repo yet return [] (history() is graceful).
  const commits = await getVersioning().history(ws.id, ws.dir);
  return NextResponse.json({ commits });
}
