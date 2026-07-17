// Accepts a list of file paths and returns them as a single ZIP archive.
// Paths are validated to stay within the workspace directory before being added to the archive.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import path from "path";
import JSZip from "jszip";
import { createLogger } from "@/lib/infra/logger";
import { addSelectedToZip, zipToStreamResponse } from "@/lib/workspace/zipDownload";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json()) as { paths?: string[] };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return NextResponse.json({ error: "paths required" }, { status: 400 });
  }

  const wsDir = path.resolve(ws.dir);
  const zip = new JSZip();
  await addSelectedToZip(
    zip,
    wsDir,
    body.paths,
    (filePath, err) =>
      createLogger("api").warn({ workspaceId: id, filePath, err }, "skipping unreadable path in download"),
    ws.name,
  );

  return zipToStreamResponse(zip, ws.name);
}
