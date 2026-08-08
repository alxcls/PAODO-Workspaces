// Returns a shared drive's file tree as nested JSON for the file tree panel.
import { NextResponse } from "next/server";
import { requireDrive } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/drives/store";
import { buildTree } from "@/lib/files/tree";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;
  const tree = await buildTree(driveContentDir(id));
  return NextResponse.json({ tree });
}
