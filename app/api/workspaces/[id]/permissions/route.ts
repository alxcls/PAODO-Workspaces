import { NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { setPermission, setGlobalPermission } from "@/lib/infra/permissionStore";
import { reconcileOsPermissions } from "@/lib/infra/osLock";
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
  const { path: inputPath, permission } = body as { path: string; permission: "R" | "RW" };

  if (!inputPath || (permission !== "R" && permission !== "RW")) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const abs = path.resolve(ws.dir, inputPath);
  if (!abs.startsWith(ws.dir + path.sep) && abs !== ws.dir) {
    return NextResponse.json({ error: "Path outside workspace" }, { status: 403 });
  }
  const relPath = path.relative(ws.dir, abs).split(path.sep).join("/") || ".";

  try {
    await setPermission(ws.id, relPath, permission, abs);
    // OS reconcile must succeed for the store + kernel state to stay in sync.
    await reconcileOsPermissions(ws.id, relPath);
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
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id }, "failed to set global permission");
    return NextResponse.json({ error: "failed to set global permission" }, { status: 500 });
  }
  return NextResponse.json({ permission });
}
