// CRUD endpoint for individual file content within a workspace.
// GET classifies and returns the file as text, image, or binary; PUT saves edited text content;
// DELETE removes the file. All paths are validated to stay within the workspace directory.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { isAgentLocked } from "@/lib/infra/permissionStore";
import { dockerExec } from "@/lib/infra/containerManager";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

// Resolves symlinks before checking the boundary so a symlink inside the workspace
// cannot silently point to a path outside it.
async function assertInsideWorkspace(wsDir: string, filePath: string): Promise<string> {
  const wsReal = await fs.realpath(wsDir);
  let resolved: string;
  try {
    resolved = await fs.realpath(filePath);
  } catch {
    // File doesn't exist yet (e.g. a write to a new path) — resolve the parent
    // directory, which must already exist, then reconstruct the full path.
    const parentReal = await fs.realpath(path.dirname(filePath));
    resolved = path.join(parentReal, path.basename(filePath));
  }
  if (!resolved.startsWith(wsReal + path.sep) && resolved !== wsReal) {
    throw new Error("Path is outside workspace");
  }
  return resolved;
}

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

  // No magic bytes detected — try UTF-8 decode
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    // SVG is text-based XML — classify as image so the viewer can render it
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<svg") || (trimmed.startsWith("<?xml") && content.includes("<svg")))
      return { type: "image", mimeType: "image/svg+xml" };
    return { type: "text", content };
  } catch {
    return { type: "binary" };
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child({ workspaceId: id, route: "files/content" });
  try {
    const resolved = await assertInsideWorkspace(ws.dir, filePath);
    const buf = await fs.readFile(resolved);
    const classified = await classifyBuffer(buf);

    // ?raw=1 — serve raw bytes for <img src> and download links
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
    log.warn({ err, filePath }, "GET file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json() as { path?: string; content?: string };
  if (!body.path || body.content === undefined) {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }

  const log = createLogger("api").child({ workspaceId: id, route: "files/content" });
  try {
    const filePath = path.isAbsolute(body.path) ? body.path : path.join(ws.dir, body.path);
    const resolved = await assertInsideWorkspace(ws.dir, filePath);
    if (await isAgentLocked(ws.id, ws.dir, resolved)) {
      return NextResponse.json({ error: "File is read-only" }, { status: 403 });
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    try {
      await fs.writeFile(resolved, body.content, "utf-8");
    } catch (writeErr) {
      const code = (writeErr as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        // File ownership is managed by the permission model — write via container as appuser (uid 1002).
        // appuser is in the access group and can write Normal/Eye-off files; locked files (mode 644)
        // are blocked by the kernel.
        const relPath = path.relative(ws.dir, resolved);
        const r = await dockerExec(ws.id, ws.dir, ["tee", `/workspace/${relPath}`], { stdin: body.content, asAppUser: true });
        if (r.code !== 0) throw new Error(r.stderr || "docker write failed");
        // Ensure mode 664 (Normal) — tee inherits the shell umask for new files.
        await dockerExec(ws.id, ws.dir, ["chmod", "664", `/workspace/${relPath}`], { asAppUser: true });
      } else {
        throw writeErr;
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err, path: body.path }, "PUT file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child({ workspaceId: id, route: "files/content" });
  try {
    const resolved = await assertInsideWorkspace(ws.dir, filePath);
    if (await isAgentLocked(ws.id, ws.dir, resolved)) {
      return NextResponse.json({ error: "File is read-only" }, { status: 403 });
    }
    await fs.access(path.dirname(resolved), fs.constants.W_OK).catch(() => {
      throw new Error("Directory is locked");
    });
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      await fs.rm(resolved, { recursive: true });
    } else {
      await fs.unlink(resolved);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err, filePath }, "DELETE file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
