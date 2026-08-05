// Accepts a list of file paths in a shared drive and returns them as a single ZIP archive.
// Paths are validated to stay within the drive directory before being added to the archive.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import path from "path";
import JSZip from "jszip";
import { driveContentDir } from "@/lib/drives/store";
import { requireDrive } from "@/lib/api/guards";
import { createLogger } from "@/lib/infra/logger";
import { addSelectedToZip, zipToStreamResponse } from "@/lib/files/zip";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;

  const body = (await req.json()) as { paths?: string[] };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return NextResponse.json({ error: "paths required" }, { status: 400 });
  }

  const driveDir = path.resolve(driveContentDir(id));
  const zip = new JSZip();
  await addSelectedToZip(
    zip,
    driveDir,
    body.paths,
    (filePath, err) =>
      createLogger("api").warn({ driveId: id, filePath, err }, "skipping unreadable path in drive download"),
    drive.name,
  );

  return zipToStreamResponse(zip, drive.name);
}
