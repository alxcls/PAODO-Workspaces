// Accepts a list of workspace-relative file paths and returns them as a single ZIP archive.
// Paths are validated to stay within the workspace directory before being added to the archive.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import JSZip from "jszip";
import { createLogger } from "@/lib/infra/logger";
import { errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { addSelectedToZip, zipToStreamResponse } from "@/lib/files/zip";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return errorResponse("INVALID_REQUEST", "paths must be a non-empty array of workspace-relative paths", {
      request: req,
      details: { field: "paths" },
    });
  }

  const zip = new JSZip();
  await addSelectedToZip(
    zip,
    ws.dir,
    body.paths,
    (filePath, err) =>
      createLogger("api").warn({ workspaceId: id, filePath, err }, "skipping unreadable path in download"),
    ws.name,
  );

  return zipToStreamResponse(zip, ws.name);
}
