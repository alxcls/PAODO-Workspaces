// REST endpoint for a workspace's crowned scripts — scripts the user authorizes to run with
// secrets injected (via the run_crowned_script tool). Only the user (UI) can crown; the agent has
// no tool to crown. Crowning a script also LOCKS it on disk (root-owned, 0444) so the agent cannot
// edit it to leak the injected secret — crown and lock stay coupled.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { crownScript, uncrownScript, listCrowned } from "@/lib/infra/crownedScriptStore";
import { setPermission, getGlobalLock } from "@/lib/infra/permissionStore";
import { ensureContainer } from "@/lib/infra/containerManager";
import { lockPathOnDisk, unlockPathOnDisk } from "@/lib/infra/osLock";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  return NextResponse.json({ crowned: listCrowned(id) });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const { path: relPath, crowned } = (await req.json()) as { path?: string; crowned?: boolean };
  if (!relPath || typeof crowned !== "boolean") {
    return NextResponse.json({ error: "path and crowned (boolean) required" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, relPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }

  try {
    if (crowned) {
      // Crown = register + lock (registry R + OS root:root) so the agent can't edit the script.
      crownScript(ws.id, relPath);
      await setPermission(ws.id, relPath, "R");
      if (!(await getGlobalLock(ws.id))) {
        await ensureContainer(ws.id, ws.dir);
        await lockPathOnDisk(ws.id, relPath);
      }
    } else {
      uncrownScript(ws.id, relPath);
      await setPermission(ws.id, relPath, "RW");
      if (!(await getGlobalLock(ws.id))) {
        await ensureContainer(ws.id, ws.dir);
        await unlockPathOnDisk(ws.id, relPath);
      }
    }
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id, path: relPath }, "failed to toggle crown");
    return NextResponse.json({ error: "failed to toggle crown" }, { status: 500 });
  }
  return NextResponse.json({ path: relPath, crowned });
}
