// Accepts a list of file paths and returns them as a single ZIP archive.
// Paths are validated to stay within the workspace directory before being added to the archive.
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json() as { paths?: string[] };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return NextResponse.json({ error: "paths required" }, { status: 400 });
  }

  const wsDir = path.resolve(ws.dir);
  const zip = new JSZip();

  await Promise.all(
    body.paths.map(async (filePath) => {
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(wsDir + path.sep)) return;
      try {
        const content = await fs.readFile(resolved);
        const relative = path.relative(wsDir, resolved);
        zip.file(relative, content);
      } catch {
        // skip unreadable files
      }
    })
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return new Response(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${ws.name}.zip"`,
    },
  });
}
