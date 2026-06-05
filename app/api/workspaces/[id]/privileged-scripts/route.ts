import { NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { setKeyed } from "@/lib/infra/permissionStore";
import { reconcileKeyedExecutable } from "@/lib/infra/osLock";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api");

// PATCH — toggle the Key (keyed) symbol on a file or directory.
// Keyed scripts run as privd (uid 998) via server-side docker exec dispatch (no sudo in container).
// After toggling, chmod +x so the script is executable when dispatched.
// body: { path: string; keyed: boolean }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = await req.json();
  const { path: relPath, keyed } = body as { path: string; keyed: boolean };

  if (!relPath || typeof keyed !== "boolean") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, relPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }

  try {
    await setKeyed(ws.id, relPath, keyed);
    await reconcileKeyedExecutable(ws.id);
  } catch (err) {
    log.error({ err, workspaceId: id, path: relPath }, "failed to set keyed");
    return NextResponse.json({ error: "failed to set keyed" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, keyed });
}
