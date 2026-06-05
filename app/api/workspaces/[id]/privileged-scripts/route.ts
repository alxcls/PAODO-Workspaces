import { getWorkspace } from "@/lib/infra/workspaceStore";
import { setKeyed, setPermission } from "@/lib/infra/permissionStore";
import { reconcileOsPermissions } from "@/lib/infra/osLock";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { NextRequest, NextResponse } from "next/server";

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
  const { path: inputPath, keyed } = body as { path: string; keyed: boolean };

  if (!inputPath || typeof keyed !== "boolean") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, inputPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }
  const relPath = path.relative(ws.dir, abs).split(path.sep).join("/") || ".";

  try {
    if (keyed) {
      await setPermission(ws.id, relPath, "R");
    }
    await setKeyed(ws.id, relPath, keyed);
    // Best-effort OS reconcile so keyed scripts are owned by privd and locked down immediately.
    await reconcileOsPermissions(ws.id, relPath).catch(() => {});
  } catch (err) {
    log.error({ err, workspaceId: id, path: relPath }, "failed to set keyed");
    return NextResponse.json({ error: "failed to set keyed" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, keyed });
}
