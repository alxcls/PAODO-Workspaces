// Handles file uploads into a workspace directory (single file or ZIP archive).
// The shared upload core (lib/workspace/fileUpload.ts) does the work; the workspace backend adds a git snapshot.
export const runtime = "nodejs";
export const maxDuration = 120;

import { type NextRequest, NextResponse } from "next/server";
import { getVersioning } from "@/lib/infra/services";
import { requireWorkspace, rateLimited } from "@/lib/api/guards";
import { snapshotWorkspace } from "@/lib/infra/git/snapshotWorkspace";
import { handleUpload } from "@/lib/workspace/fileUpload";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const limited = rateLimited(req, { max: 200, bucket: "upload", logContext: { workspaceId: id } });
  if (limited) return limited;

  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  return handleUpload(req, {
    dir: ws.dir,
    logContext: { workspaceId: id },
    afterWrite: async (message) => {
      await snapshotWorkspace(getVersioning(), ws, message);
    },
  });
}
