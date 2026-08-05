// REST endpoint for a single shared drive.
// PATCH renames it; DELETE removes the drive, its connections, and its files on disk.
import { type NextRequest, NextResponse } from "next/server";
import { updateDrive, deleteDrive, DriveNameError } from "@/lib/drives/store";
import { requireDrive, notFound } from "@/lib/api/guards";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api");

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
    if (err instanceof DriveNameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    log.error(
      { event: "drive_update_failed", outcome: "drive_update_not_persisted", err, driveId: id },
      "failed to update drive",
    );
    return NextResponse.json({ error: "failed to update drive" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deleted = await deleteDrive(id);
  return NextResponse.json({ deleted });
}
