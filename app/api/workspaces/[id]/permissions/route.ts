// Per-file permission controls (lock / hide / privilege) for a workspace. The UI toggles these via
// PATCH; each toggle mutates the permission store (applying the privilege⇄lock coupling) and then
// reconciles the on-disk OS ownership/modes so the kernel enforces the new state immediately.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import path from "path";
import { getStore, getContainers } from "@/lib/infra/services";
import { assertInsideWorkspace } from "@/lib/infra/workspaceContainment";
import { setControl, getPermissions, type PermissionControl } from "@/lib/infra/permissionStore";
import { reconcileOsPermissions } from "@/lib/infra/osLock";
import { createLogger } from "@/lib/infra/logger";

const CONTROLS: PermissionControl[] = ["lock", "hide", "privilege"];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(getPermissions(id));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json()) as { path?: string; control?: string; value?: boolean };
  if (!body.path || !body.control || typeof body.value !== "boolean" || !CONTROLS.includes(body.control as PermissionControl)) {
    return NextResponse.json({ error: "path, control (lock|hide|privilege) and boolean value required" }, { status: 400 });
  }

  const log = createLogger("api").child({ workspaceId: id, route: "permissions" });
  try {
    // The tree sends absolute host paths; normalize to a workspace-relative key.
    const resolved = await assertInsideWorkspace(ws.dir, body.path);
    const relPath = path.relative(ws.dir, resolved);

    const perms = setControl(id, relPath, body.control as PermissionControl, body.value);
    await reconcileOsPermissions(
      (cmd) => getContainers().execAsRoot(id, ws.dir, cmd),
      id,
      relPath,
    );
    return NextResponse.json(perms);
  } catch (err) {
    log.warn({ err, path: body.path }, "PATCH permission failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
