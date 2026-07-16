// REST endpoint for a single shared drive.
// PATCH renames it; DELETE removes the drive, its connections, and its files on disk.
import { type NextRequest, NextResponse } from "next/server";
import { updateDrive, deleteDrive } from "@/lib/workspace/driveStore";
import { requireDrive, notFound } from "@/lib/api/guards";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;
  return NextResponse.json(drive);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as { name?: string };
  try {
    const drive = updateDrive(id, body);
    if (!drive) return notFound();
    return NextResponse.json(drive);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deleted = await deleteDrive(id);
  return NextResponse.json({ deleted });
}
