import { NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { setPermission, setGlobalPermission, getGlobalLock } from "@/lib/infra/permissionStore";
import { ensureContainer } from "@/lib/infra/containerManager";
import { lockPathOnDisk, unlockPathOnDisk } from "@/lib/infra/osLock";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = await req.json();
  const { path: relPath, permission } = body as { path: string; permission: "R" | "RW" };

  if (!relPath || (permission !== "R" && permission !== "RW")) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, relPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }

  try {
    await setPermission(ws.id, relPath, permission);
    // Mirror the registry change into real OS permissions so the lock holds against
    // execute_command (which runs as the non-root `developer`), not just the app-layer tools.
    // Skipped while globally locked: the workspace mount is read-only, so chown/chmod can't run
    // and the :ro mount already enforces everything.
    if (!(await getGlobalLock(ws.id))) {
      await ensureContainer(ws.id, ws.dir);
      if (permission === "R") await lockPathOnDisk(ws.id, relPath);
      else await unlockPathOnDisk(ws.id, relPath);
    }
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id, path: relPath }, "failed to set permission");
    return NextResponse.json({ error: "failed to set permission" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, permission });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const { permission } = (await req.json()) as { permission: "R" | "RW" };
  if (permission !== "R" && permission !== "RW") {
    return NextResponse.json({ error: "Invalid permission" }, { status: 400 });
  }

  try {
    await setGlobalPermission(ws.id, permission);
    // Recreate the container so the volume is mounted read-only (R) or read-write (RW). The
    // mismatch between the stored lock label and the new state triggers recreation inside
    // ensureContainer, and reconcileOsPermissions then re-applies any per-path locks.
    await ensureContainer(ws.id, ws.dir);
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id }, "failed to set global permission");
    return NextResponse.json({ error: "failed to set global permission" }, { status: 500 });
  }
  return NextResponse.json({ permission });
}
