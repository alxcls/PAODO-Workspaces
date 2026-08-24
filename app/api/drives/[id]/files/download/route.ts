// Accepts a list of drive-relative file paths and returns them as a single ZIP archive.
// Paths are validated to stay within the drive directory before being added to the archive.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import JSZip from "jszip";
import { driveContentDir } from "@/lib/drives/store";
import { requireDrive } from "@/lib/api/guards";
import { createLogger } from "@/lib/infra/logger";
import { errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { addSelectedToZip, zipToStreamResponse } from "@/lib/files/zip";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id, req);
  if (drive instanceof NextResponse) return drive;

  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return errorResponse("INVALID_REQUEST", "paths must be a non-empty array of drive-relative paths", {
      request: req,
      details: { field: "paths" },
    });
  }

  const zip = new JSZip();
  await addSelectedToZip(
    zip,
    driveContentDir(id),
    body.paths,
    (filePath, err) =>
      createLogger("api").warn({ driveId: id, filePath, err }, "skipping unreadable path in drive download"),
    drive.name,
  );

  return zipToStreamResponse(zip, drive.name);
}
