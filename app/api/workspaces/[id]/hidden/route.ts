import { NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { setHidden, readPermissionSnapshot, isKeyedFromSnapshot } from "@/lib/infra/permissionStore";
import { reconcileOsPermissions } from "@/lib/infra/osLock";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { isExecutable } from "@/lib/utils/fileType";

const log = createLogger("api");

// PATCH — toggle the Eye (hidden) symbol on a single file or directory.
// body: { path: string; hidden: boolean }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = await req.json();
  const { path: inputPath, hidden } = body as { path: string; hidden: boolean };

  if (!inputPath || typeof hidden !== "boolean") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, inputPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }
  const relPath = path.relative(ws.dir, abs).split(path.sep).join("/") || ".";

  if (hidden && isExecutable(path.basename(abs))) {
    return NextResponse.json(
      { error: "Eye permission cannot be applied to executable scripts" },
      { status: 400 }
    );
  }

  if (hidden) {
    const snapshot = await readPermissionSnapshot(ws.id);
    if (isKeyedFromSnapshot(snapshot, relPath)) {
      return NextResponse.json(
        { error: "Eye permission cannot be applied to keyed scripts" },
        { status: 400 }
      );
    }
  }

  try {
    await setHidden(ws.id, relPath, hidden);
    // OS reconcile must succeed for the store + kernel state to stay in sync.
    // If this fails, surface an error so the user knows the toggle did not fully apply.
    await reconcileOsPermissions(ws.id, relPath);
  } catch (err) {
    log.error({ err, workspaceId: id, path: relPath }, "failed to set hidden");
    return NextResponse.json({ error: "failed to set hidden" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, hidden });
}
