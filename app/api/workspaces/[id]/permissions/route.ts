import { NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { setPermission, setGlobalPermission, getGlobalLock } from "@/lib/infra/permissionStore";
import { isPrivileged, revokePrivilege } from "@/lib/infra/privilegeStore";
import { isHidden } from "@/lib/infra/hiddenStore";
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
    // Unlocking a privileged path auto-revokes privilege (privilege implies lock; the only way to
    // break that coupling is to unlock, which signals the user no longer needs secret injection).
    if (permission === "RW" && isPrivileged(ws.id, relPath)) {
      revokePrivilege(ws.id, relPath);
    }

    await setPermission(ws.id, relPath, permission);

    // Mirror the registry change into real OS permissions. Skipped while globally locked (:ro
    // mount already enforces it) or while the file is hidden (hideOnDisk is already in place and
    // is more restrictive than lockOnDisk — restore happens when the file is revealed).
    if (!isHidden(ws.id, relPath) && !(await getGlobalLock(ws.id))) {
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
