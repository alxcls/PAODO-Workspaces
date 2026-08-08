// Unified diff between two versioning commits of a workspace.
import { NextResponse, type NextRequest } from "next/server";
import { getVersioning } from "@/lib/infra/services";
import { requireWorkspace } from "@/lib/api/guards";
import { errorResponse } from "@/lib/api/errorResponse";
import { isSnapshotSha } from "@/lib/infra/git/sha";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    return errorResponse("INVALID_REQUEST", "from and to required", { request: req });
  }
  if (!isSnapshotSha(from) || !isSnapshotSha(to)) {
    return errorResponse("INVALID_REQUEST", "invalid sha", {
      request: req,
      details: { fields: [!isSnapshotSha(from) ? "from" : "to"] },
    });
  }

  const diff = await getVersioning().diff(ws.id, ws.dir, from, to);
  return NextResponse.json({ diff });
}
