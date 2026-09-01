// Durable disk weight of one workspace, powering the storage line on the home panel.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { notFound, workspaceIdParam } from "@/lib/api/guards";
import { errorResponse } from "@/lib/api/errorResponse";
import { getWorkspace } from "@/lib/operations/workspace/read";
import { getWorkspaceDiskUsage } from "@/lib/infra/storage/workspaceDiskUsage";

const log = createLogger("api").child({ route: "workspace-storage" });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const param = workspaceIdParam((await params).id, req);
  if (param instanceof NextResponse) return param;
  const id = param;
  if (!getWorkspace(id)) return notFound(req);
  try {
    const usage = await getWorkspaceDiskUsage(id);
    return NextResponse.json(usage, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    log.error(
      { event: "workspace_storage_failed", outcome: "usage_not_returned", code: "INTERNAL_ERROR", err, workspaceId: id },
      "failed to measure workspace storage",
    );
    return errorResponse("INTERNAL_ERROR", "failed to measure workspace storage", { request: req });
  }
}
