// Returns the workspace file tree as a nested JSON structure for the file tree panel.
import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { buildTree } from "@/lib/workspace/fileTree";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  const tree = await buildTree(ws.dir);
  return NextResponse.json({ tree });
}
