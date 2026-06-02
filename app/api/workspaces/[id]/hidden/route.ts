// REST endpoint for a workspace's hidden files — files whose CONTENT the user wants invisible to
// the agent while still present in the workspace. Only the user (UI eye icon) can hide; the agent
// has no tool to hide. Hiding makes the path root-owned + group-readable only by the app server
// (see osLock.hidePathOnDisk), so the agent (`developer`) can never read it. Hiding also LOCKS the
// path (registry R), and hidden/secured are mutually exclusive.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { hideFile, unhideFile, listHidden } from "@/lib/infra/hiddenStore";
import { isSecured } from "@/lib/infra/securedScriptStore";
import { setPermission, getGlobalLock } from "@/lib/infra/permissionStore";
import { ensureContainer } from "@/lib/infra/containerManager";
import { hidePathOnDisk, unhidePathOnDisk } from "@/lib/infra/osLock";
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

  // Hidden and secured are mutually exclusive — a secured script must stay readable so the agent
  // can reason about what it runs; a hidden file must not be runnable-with-secrets.
  if (hidden && isSecured(ws.id, relPath)) {
    return NextResponse.json({ error: "Cannot hide a secured script; unsecure it first" }, { status: 400 });
  }

  try {
    if (hidden) {
      // Hide = register + lock (registry R + OS root:APP_GID 0640) so the agent can't read content.
      hideFile(ws.id, relPath);
      await setPermission(ws.id, relPath, "R");
      if (!(await getGlobalLock(ws.id))) {
        await ensureContainer(ws.id, ws.dir);
        await hidePathOnDisk(ws.id, relPath);
      }
    } else {
      unhideFile(ws.id, relPath);
      await setPermission(ws.id, relPath, "RW");
      if (!(await getGlobalLock(ws.id))) {
        await ensureContainer(ws.id, ws.dir);
        await unhidePathOnDisk(ws.id, relPath);
      }
    }
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id, path: relPath }, "failed to toggle hidden");
    return NextResponse.json({ error: "failed to toggle hidden" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, hidden });
}
