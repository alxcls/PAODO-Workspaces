// CRUD endpoint for individual file content within a workspace.
// GET classifies and returns the file as text, image, or binary; PUT saves edited text content;
// DELETE removes the file. All paths are validated to stay within the workspace directory.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getStore, getContainers, getVersioning } from "@/lib/infra/services";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { assertInsideWorkspace } from "@/lib/infra/workspaceContainment";
import { snapshotWorkspace } from "@/lib/infra/git/snapshotWorkspace";
import { removePath } from "@/lib/infra/permissionStore";

// The app server is trusted infra, but it runs as a different uid than `privd`, which owns
// locked/hidden files. So for protected paths the direct host-fs syscall hits EACCES; we then go
// through the container as root. This is what guarantees "the user can always view and modify
// hidden/locked content" regardless of the on-disk protection the agent is subject to.
type Ws = { id: string; dir: string };

async function readFileWithFallback(ws: Ws, resolved: string): Promise<Buffer> {
  try {
    return await fs.readFile(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
    // base64 so binary content survives the string round-trip through docker exec.
    const rel = path.relative(ws.dir, resolved);
    const r = await getContainers().execAsRoot(ws.id, ws.dir, ["base64", `/workspace/${rel}`]);
    if (r.code !== 0) throw new Error(r.stderr || "read failed");
    return Buffer.from(r.stdout, "base64");
  }
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
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child({ workspaceId: id, route: "files/content" });
  try {
    const resolved = await assertInsideWorkspace(ws.dir, filePath);
    const buf = await readFileWithFallback(ws, resolved);
    const classified = await classifyBuffer(buf);

    // ?raw=1 — serve raw bytes for <img src> and download links
    if (searchParams.get("raw") === "1") {
      const mime = classified.type === "image" ? classified.mimeType : "application/octet-stream";
      const isDownload = searchParams.get("download") === "1";
      return new Response(new Uint8Array(buf), {
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
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json() as { path?: string; content?: string };
  if (!body.path || body.content === undefined) {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }

  const log = createLogger("api").child({ workspaceId: id, route: "files/content" });
  try {
    const filePath = path.isAbsolute(body.path) ? body.path : path.join(ws.dir, body.path);
    const resolved = await assertInsideWorkspace(ws.dir, filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    try {
      await fs.writeFile(resolved, body.content, "utf-8");
    } catch (writeErr) {
      const code = (writeErr as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        // The target is a locked/hidden file owned by `privd` (or a legacy root-owned file). The app
        // user is allowed to modify it, so write through the container as root. tee rewrites content
        // without changing ownership, so the file's protection (privd ownership) is preserved.
        const relPath = path.relative(ws.dir, resolved);
        const r = await getContainers().execAsRoot(ws.id, ws.dir, ["tee", `/workspace/${relPath}`], { stdin: body.content });
        if (r.code !== 0) throw new Error(r.stderr || "docker write failed");
      } else {
        throw writeErr;
      }
    }
    await snapshotWorkspace(getVersioning(), ws, `saved ${path.basename(resolved)}`);
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
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child({ workspaceId: id, route: "files/content" });
  try {
    const resolved = await assertInsideWorkspace(ws.dir, filePath);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) await fs.rm(resolved, { recursive: true });
      else await fs.unlink(resolved);
    } catch (rmErr) {
      const code = (rmErr as NodeJS.ErrnoException).code;
      // A protected entry lives in a sticky, non-app-owned directory, so the app user cannot unlink
      // it directly. The user is allowed to delete it, so fall back to a root rm in the container.
      if (code === "EACCES" || code === "EPERM") {
        const relPath = path.relative(ws.dir, resolved);
        const r = await getContainers().execAsRoot(ws.id, ws.dir, ["rm", "-rf", `/workspace/${relPath}`]);
        if (r.code !== 0) throw new Error(r.stderr || "docker delete failed");
      } else {
        throw rmErr;
      }
    }
    removePath(ws.id, path.relative(ws.dir, resolved));
    await snapshotWorkspace(getVersioning(), ws, `deleted ${path.basename(resolved)}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err, filePath }, "DELETE file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
