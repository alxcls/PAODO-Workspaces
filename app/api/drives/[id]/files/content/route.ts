// CRUD endpoint for individual file content within a shared drive.
// GET classifies and returns the file as text, image, or binary; PUT saves edited text; DELETE removes.
// Drives are passive host storage: no git snapshots, no container — the shared file-content core
// (lib/workspace/fileContent.ts) runs with a bare backend (plain fs writes, no fallback/snapshot).
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireDrive } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/workspace/driveStore";
import { getFileContent, putFileContent, deleteFileContent, type FileBackend } from "@/lib/workspace/fileContent";

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

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;
  return deleteFileContent(req, backend(id));
}
