// CRUD endpoint for individual file content within a workspace.
// GET classifies and returns the file as text, image, or binary; PUT saves edited text content;
// PATCH moves and DELETE removes the file. The shared file-content core
// (lib/workspace/fileContent.ts) does the work; the workspace backend adds a container
// write-fallback for legacy root-owned files and a git snapshot.
//
// The container write-fallback covers PUT only; moving a legacy root-owned file still fails with a
// "not writable" error rather than falling back. New agent writes are uid-1000-owned, so this only
// affects files created before the non-root migration and not yet swept.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import path from "path";
import { getContainers, getVersioning } from "@/lib/infra/services";
import { requireWorkspace } from "@/lib/api/guards";
import { snapshotWorkspace } from "@/lib/infra/git/snapshotWorkspace";
import { getFileContent, putFileContent, moveFileContent, deleteFileContent, type FileBackend } from "@/lib/workspace/fileContent";
import type { Workspace } from "@/lib/workspace/workspaceStore";

function backend(ws: Workspace): FileBackend {
  return {
    dir: ws.dir,
    logContext: { workspaceId: ws.id, route: "files/content" },
    // Fallback for legacy root-owned files (created before the non-root migration, not yet swept):
    // overwrite through the container. The Node snippet deliberately opens with r+ and no create,
    // preserving the shared core's guarantee that a concurrent move cannot recreate an old path.
    writeFallback: async (resolved, content) => {
      const relPath = path.relative(ws.dir, resolved);
      const overwriteExisting = [
        "const fs=require('fs');",
        "const fd=fs.openSync(process.argv[1],'r+');",
        "try{fs.ftruncateSync(fd,0);fs.writeFileSync(fd,fs.readFileSync(0,'utf8'),'utf8');}",
        "finally{fs.closeSync(fd);}",
      ].join("");
      const r = await getContainers().exec(
        ws.id,
        ws.dir,
        ["node", "-e", overwriteExisting, `/workspace/${relPath}`],
        { stdin: content },
      );
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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return moveFileContent(req, backend(ws));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return deleteFileContent(req, backend(ws));
}
