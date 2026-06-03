// REST endpoint for a workspace's privileged scripts — scripts the user authorizes to run with
// elevated privilege (secrets injected via docker exec -u root). Only the user (UI) can grant
// privilege; the agent has no tool to do so.
//
// Privilege ↔ lock coupling: granting privilege automatically locks the path (so the agent cannot
// tamper with it). Revoking privilege is metadata-only — the lock is not changed. Unlocking a
// privileged path (via the permissions route) auto-revokes privilege before setting RW.
// Hidden and privilege are independent — a hidden+privileged file is allowed.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { grantPrivilege, revokePrivilege, listPrivileged } from "@/lib/infra/privilegeStore";
import { isHidden } from "@/lib/infra/hiddenStore";
import { setPermission, getGlobalLock } from "@/lib/infra/permissionStore";
import { ensureContainer } from "@/lib/infra/containerManager";
import { lockPathOnDisk } from "@/lib/infra/osLock";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  return NextResponse.json({ privileged: listPrivileged(id) });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const { path: relPath, privileged } = (await req.json()) as { path?: string; privileged?: boolean };
  if (!relPath || typeof privileged !== "boolean") {
    return NextResponse.json({ error: "path and privileged (boolean) required" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, relPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }

  try {
    if (privileged) {
      // Grant privilege = register + auto-lock (registry R + OS root:root) so the agent can't tamper.
      // If the file is hidden, hideOnDisk already prevents agent access — skip disk lock (more restrictive).
      grantPrivilege(ws.id, relPath);
      await setPermission(ws.id, relPath, "R");
      // Skip OS lock while hidden (hideOnDisk is more restrictive) or globally locked
      // (workspace-wide a-w already enforces it; reconcile re-asserts on global unlock).
      if (!isHidden(ws.id, relPath) && !(await getGlobalLock(ws.id))) {
        await ensureContainer(ws.id, ws.dir);
        await lockPathOnDisk(ws.id, relPath);
      }
    } else {
      // Revoke privilege = metadata only. The lock remains in place; only an explicit unlock clears it.
      revokePrivilege(ws.id, relPath);
    }
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id, path: relPath }, "failed to toggle privilege");
    return NextResponse.json({ error: "failed to toggle privilege" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, privileged });
}
