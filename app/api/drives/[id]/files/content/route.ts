// CRUD endpoint for individual file content within a shared drive.
// GET classifies and returns the file as text, image, or binary; PUT saves edited text; PATCH moves;
// DELETE removes.
// Drives are passive host storage: no git snapshots, no container. Shared workspace file modules
// run with a bare backend (plain fs writes, no fallback/snapshot).
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireDrive } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/drives/store";
import { getFileContent, putFileContent, deleteFileContent } from "@/lib/api/fileContentRoutes";
import { moveFileContent } from "@/lib/files/move";
import type { FileBackend } from "@/lib/files/backend";

function backend(id: string): FileBackend {
  return { dir: driveContentDir(id), logContext: { driveId: id, route: "drive-files/content" } };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;
  return getFileContent(req, backend(id));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;
  return putFileContent(req, backend(id));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;
  return moveFileContent(req, backend(id));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;
  return deleteFileContent(req, backend(id));
}
