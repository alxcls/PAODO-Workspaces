// REST endpoint for the shared-drive collection.
// GET returns all drives; POST creates a new one with an isolated content directory on disk.
import { NextRequest, NextResponse } from "next/server";
import { listDrives, createDrive, DriveNameError } from "@/lib/workspace/driveStore";
import { createLogger } from "@/lib/infra/logger";

export function GET() {
  return NextResponse.json(listDrives());
}

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "drives" });
  const body = (await req.json()) as { name?: string; description?: string };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const drive = createDrive(body.name.trim(), body.description);
    return NextResponse.json(drive, { status: 201 });
  } catch (err) {
    // A rejected name is the user's to fix: 400 with the reason, no log line. Everything else here
    // is mkdir/atomicSaveJson failing — a system fault that was previously answered with a 400 and
    // buried among the validation noise, so it becomes a 500 an operator can see.
    if (err instanceof DriveNameError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    log.error(
      { event: "drive_create_failed", outcome: "drive_not_created", err, name: body.name },
      "failed to create drive",
    );
    return NextResponse.json({ error: "failed to create drive" }, { status: 500 });
  }
}
