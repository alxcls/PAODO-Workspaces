// Roll a workspace back to a previous versioning commit (hard reset of the work-tree). Mutating +
// destructive, so it's rate-limited like the other write endpoints.
//
// Translation only: the ref rules and the reset itself are lib/operations/workspace/restore.ts. What
// is left here is HTTP — resolving the workspace, reading the body, and turning an AppError into a
// status.
import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { restoreWorkspace } from "@/lib/operations/workspace/restore";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api").child({ route: "restore" });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    return NextResponse.json(await restoreWorkspace(ws, parsed));
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_restore_failed",
        outcome: "work_tree_left_at_previous_revision",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to restore workspace",
    );
    return errorResponse("INTERNAL_ERROR", "failed to restore workspace", { request: req });
  }
}
