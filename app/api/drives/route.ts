// REST endpoint for the shared-drive collection.
// GET returns all drives; POST creates a new one with an isolated content directory on disk.
import { NextRequest, NextResponse } from "next/server";
import { listDrives, createDrive } from "@/lib/workspace/driveStore";
import { createLogger } from "@/lib/infra/logger";
import { rateLimited } from "@/lib/api/guards";

export function GET() {
  return NextResponse.json(listDrives());
}

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "drives" });
  const limited = rateLimited(req, { logContext: { route: "drives" } });
  if (limited) return limited;

  const body = (await req.json()) as { name?: string; description?: string };
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const drive = createDrive(body.name.trim(), body.description);
    return NextResponse.json(drive, { status: 201 });
  } catch (err) {
    log.error({ err, name: body.name }, "failed to create drive");
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
