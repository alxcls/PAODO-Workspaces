// CRUD endpoint for individual file content within a shared drive.
// GET classifies and returns the file as text, image, or binary; PUT saves edited text;
// DELETE removes the file. All paths are validated to stay within the drive directory.
// Drives are passive host storage: no git snapshots, no container — plain fs writes.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getDrive, driveContentDir } from "@/lib/workspace/driveStore";
import { createLogger } from "@/lib/infra/logger";
import { assertInsideWorkspace } from "@/lib/infra/workspaceContainment";

type FileClass =
  | { type: "image"; mimeType: string }
  | { type: "text"; content: string }
  | { type: "binary" };

async function classifyBuffer(buf: Buffer): Promise<FileClass> {
  const { fileTypeFromBuffer } = await import("file-type");
  const result = await fileTypeFromBuffer(buf);
  if (result) {
    if (result.mime.startsWith("image/")) return { type: "image", mimeType: result.mime };
    return { type: "binary" };
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<svg") || (trimmed.startsWith("<?xml") && content.includes("<svg")))
      return { type: "image", mimeType: "image/svg+xml" };
    return { type: "text", content };
  } catch {
    return { type: "binary" };
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getDrive(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const driveDir = driveContentDir(id);

  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child({ driveId: id, route: "drive-files/content" });
  try {
    const resolved = await assertInsideWorkspace(driveDir, filePath);
    const buf = await fs.readFile(resolved);
    const classified = await classifyBuffer(buf);

    if (searchParams.get("raw") === "1") {
      const mime = classified.type === "image" ? classified.mimeType : "application/octet-stream";
      const isDownload = searchParams.get("download") === "1";
      return new Response(buf, {
        headers: {
          "Content-Type": mime,
          ...(isDownload ? { "Content-Disposition": `attachment; filename="${path.basename(resolved)}"` } : {}),
        },
      });
    }

    if (classified.type === "text") return NextResponse.json({ type: "text", content: classified.content });
    if (classified.type === "image") return NextResponse.json({ type: "image" });
    return NextResponse.json({ type: "binary" });
  } catch (err) {
    log.warn({ err, filePath }, "GET drive file failed");
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 400 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getDrive(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const driveDir = driveContentDir(id);

  const body = (await req.json()) as { path?: string; content?: string };
  if (!body.path || body.content === undefined) {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }

  const log = createLogger("api").child({ driveId: id, route: "drive-files/content" });
  try {
    const filePath = path.isAbsolute(body.path) ? body.path : path.join(driveDir, body.path);
    const resolved = await assertInsideWorkspace(driveDir, filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, body.content, "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err, path: body.path }, "PUT drive file failed");
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getDrive(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const driveDir = driveContentDir(id);

  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child({ driveId: id, route: "drive-files/content" });
  try {
    const resolved = await assertInsideWorkspace(driveDir, filePath);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) await fs.rm(resolved, { recursive: true });
    else await fs.unlink(resolved);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err, filePath }, "DELETE drive file failed");
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 400 });
  }
}
