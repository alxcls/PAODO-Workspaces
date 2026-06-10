// Accepts a list of file paths and returns them as a single ZIP archive.
// Paths are validated to stay within the workspace directory before being added to the archive.
import { NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { createLogger } from "@/lib/infra/logger";

async function addDirToZip(zip: JSZip, dirPath: string, zipPath: string) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      const entryZipPath = path.join(zipPath, entry.name);
      if (entry.isDirectory()) {
        await addDirToZip(zip, fullPath, entryZipPath);
      } else {
        zip.file(entryZipPath, await fs.readFile(fullPath));
      }
    })
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
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
        const stat = await fs.stat(resolved);
        const relative = path.relative(wsDir, resolved);
        if (stat.isDirectory()) {
          await addDirToZip(zip, resolved, relative);
        } else {
          zip.file(relative, await fs.readFile(resolved));
        }
      } catch (err) {
        createLogger("api").warn({ workspaceId: id, filePath, err }, "skipping unreadable path in download");
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
