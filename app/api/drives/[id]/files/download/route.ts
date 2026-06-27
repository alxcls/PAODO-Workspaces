// Accepts a list of file paths in a shared drive and returns them as a single ZIP archive.
// Paths are validated to stay within the drive directory before being added to the archive.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import path from "path";
import JSZip from "jszip";
import { getDrive, driveContentDir } from "@/lib/workspace/driveStore";
import { createLogger } from "@/lib/infra/logger";
import { addSelectedToZip, zipToStreamResponse } from "@/lib/workspace/zipDownload";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = getDrive(id);
  if (!drive) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json()) as { paths?: string[] };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return NextResponse.json({ error: "paths required" }, { status: 400 });
  }

  const driveDir = path.resolve(driveContentDir(id));
  const zip = new JSZip();
  await addSelectedToZip(zip, driveDir, body.paths, (filePath, err) =>
    createLogger("api").warn({ driveId: id, filePath, err }, "skipping unreadable path in drive download"),
  );

  return zipToStreamResponse(zip, drive.name);
}
