// REST endpoint for a single shared drive.
// PATCH renames it; DELETE removes the drive, its connections, and its files on disk.
import { type NextRequest, NextResponse } from "next/server";
import { updateDrive, deleteDrive, DriveNameError } from "@/lib/drives/store";
import { requireDrive, notFound } from "@/lib/api/guards";
import { errorResponse } from "@/lib/api/errorResponse";
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
    if (!drive) return notFound(req);
    return NextResponse.json(drive);
  } catch (err) {
    if (err instanceof DriveNameError) {
      return errorResponse("INVALID_REQUEST", err.message, { request: req });
    }
    log.error(
      { event: "drive_update_failed", outcome: "drive_update_not_persisted", err, driveId: id },
      "failed to update drive",
    );
    return errorResponse("INTERNAL_ERROR", "failed to update drive", { request: req });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const deleted = await deleteDrive(id);
    return NextResponse.json({ deleted });
  } catch (err) {
    log.error(
      { event: "drive_delete_failed", outcome: "drive_not_deleted", err, driveId: id },
      "failed to delete drive",
    );
    return errorResponse("INTERNAL_ERROR", "failed to delete drive", { request: req });
  }
}
