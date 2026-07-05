// CRUD endpoint for individual file content within a workspace.
// GET classifies and returns the file as text, image, or binary; PUT saves edited text content;
// DELETE removes the file. The shared file-content core (lib/workspace/fileContent.ts) does the work;
// the workspace backend adds a container write-fallback for legacy root-owned files and a git snapshot.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import path from "path";
import { getContainers, getVersioning } from "@/lib/infra/services";
import { requireWorkspace } from "@/lib/api/guards";
import { snapshotWorkspace } from "@/lib/infra/git/snapshotWorkspace";
import { getFileContent, putFileContent, deleteFileContent, type FileBackend } from "@/lib/workspace/fileContent";
import type { Workspace } from "@/lib/workspace/workspaceStore";

function backend(ws: Workspace): FileBackend {
  return {
    dir: ws.dir,
    logContext: { workspaceId: ws.id, route: "files/content" },
    // Fallback for legacy root-owned files (created before the non-root migration, not yet swept):
    // write through the container. New agent writes are uid-1000-owned so the direct fs.writeFile
    // succeeds and this path is not hit.
    writeFallback: async (resolved, content) => {
      const relPath = path.relative(ws.dir, resolved);
      const r = await getContainers().exec(ws.id, ws.dir, ["tee", `/workspace/${relPath}`], { stdin: content });
      if (r.code !== 0) throw new Error(r.stderr || "docker write failed");
    },
    afterWrite: async (message) => {
      await snapshotWorkspace(getVersioning(), ws, message);
    },
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return getFileContent(req, backend(ws));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return putFileContent(req, backend(ws));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return deleteFileContent(req, backend(ws));
}
