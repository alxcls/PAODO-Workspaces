// REST endpoint for a workspace's hidden files — files whose CONTENT the user wants invisible to
// the agent while still present in the workspace. Only the user (UI eye icon) can hide; the agent
// has no tool to hide. Hiding makes the path root-owned + group-readable only by the app server
// (see osLock.hidePathOnDisk), so the agent (`developer`) can never read it.
// Visibility, lock, and privilege are independent — hiding does not auto-lock the path.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { hideFile, unhideFile, listHidden } from "@/lib/infra/hiddenStore";
import { readPermissionSnapshot, getGlobalLock } from "@/lib/infra/permissionStore";
import { isPrivileged } from "@/lib/infra/privilegeStore";
import { ensureContainer } from "@/lib/infra/containerManager";
import { hidePathOnDisk, unhidePathOnDisk, lockPathOnDisk } from "@/lib/infra/osLock";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  return NextResponse.json({ hidden: listHidden(id) });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const { path: relPath, hidden } = (await req.json()) as { path?: string; hidden?: boolean };
  if (!relPath || typeof hidden !== "boolean") {
    return NextResponse.json({ error: "path and hidden (boolean) required" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, relPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }

  try {
    if (hidden) {
      // Hide = register + apply OS root:APP_GID 0640 so the agent can't read content.
      hideFile(ws.id, relPath);
      if (!(await getGlobalLock(ws.id))) {
        await ensureContainer(ws.id, ws.dir);
        await hidePathOnDisk(ws.id, relPath);
      }
    } else {
      // Unhide = unregister, then restore the disk state dictated by the current lock setting.
      unhideFile(ws.id, relPath);
      if (!(await getGlobalLock(ws.id))) {
        await ensureContainer(ws.id, ws.dir);
        const snap = await readPermissionSnapshot(ws.id);
        const parts = relPath.split(path.sep);
        const isLocked = parts.some((_, i) => snap.locked.includes(parts.slice(0, i + 1).join(path.sep)));
        if (isLocked || isPrivileged(ws.id, relPath)) {
          await lockPathOnDisk(ws.id, relPath);
        } else {
          await unhidePathOnDisk(ws.id, relPath);
        }
      }
    }
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id, path: relPath }, "failed to toggle hidden");
    return NextResponse.json({ error: "failed to toggle hidden" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, hidden });
}
