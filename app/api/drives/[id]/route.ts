// REST endpoint for a single shared drive.
// GET returns it; PATCH renames or re-describes it; DELETE removes the drive, its connections, and
// its files on disk.
//
// Translation only: the name rules and the not-found answers are lib/operations/drives/manage.ts, so
// the UI and the CLI get the same refusal without either restating it. What is left here is HTTP —
// reading the body, and turning an AppError into a status.
import { type NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { deleteDrive, updateDrive } from "@/lib/operations/drives/manage";
import { getDriveOverview } from "@/lib/operations/drives/overview";

const log = createLogger("api").child({ route: "drive" });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(getDriveOverview(id), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error({ event: "drive_read_failed", outcome: "drive_not_returned", err, driveId: id }, "failed to read drive");
    return errorResponse("INTERNAL_ERROR", "failed to read drive", { request: req });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // readJsonObject rather than req.json(): a malformed body is a 400 here, as it is everywhere else,
  // instead of an exception that leaves this route as a 500.
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    // no-store because a receipt describes one moment of a mutable resource, not a cacheable read.
    return NextResponse.json(updateDrive(id, parsed), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
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
    // `ok` alongside `deleted`, so this receipt branches the same way every other mutation's does —
    // and a drive that was never there is a 404 rather than a success reporting `deleted: false`.
    return NextResponse.json({ ok: true, ...(await deleteDrive(id)) });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      { event: "drive_delete_failed", outcome: "drive_not_deleted", err, driveId: id },
      "failed to delete drive",
    );
    return errorResponse("INTERNAL_ERROR", "failed to delete drive", { request: req });
  }
}
