// Shared file-content CRUD for the workspace and drive file routes.
// GET classifies a file as text/image/binary (or serves raw bytes), PUT writes text, and DELETE
// removes. Move policy is isolated in fileMove.ts.
// All paths are validated to stay inside the backend directory via assertInsideWorkspace.
//
// PUT updates an existing file and never creates one: it opens without O_CREAT so that a save
// racing a move fails with ENOENT (surfaced as 409) instead of resurrecting the old path. Any
// future caller that needs create-on-save must add it deliberately, not by relaxing the open flags.
//
// The two callers differ only in their FileBackend: a workspace supplies a container `writeFallback`
// (for legacy root-owned files) and an `afterWrite` git snapshot; a drive is passive host storage and
// supplies neither. Everything else — classification, containment, raw serving — is identical here.
//
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { assertInsideWorkspace } from "@/lib/infra/workspaceContainment";
import { lexicalFilePath, logFileRouteError, type FileBackend } from "./fileBackend";

type FileClass = { type: "image"; mimeType: string } | { type: "text"; content: string } | { type: "binary" };

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

export async function getFileContent(req: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child(be.logContext);
  try {
    const resolved = await assertInsideWorkspace(be.dir, filePath);
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
    logFileRouteError(log, err, { filePath }, "GET file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function putFileContent(req: Request, be: FileBackend): Promise<Response> {
  const body = (await req.json()) as { path?: string; content?: string };
  if (!body.path || body.content === undefined) {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }

  const log = createLogger("api").child(be.logContext);
  try {
    const resolved = await assertInsideWorkspace(be.dir, lexicalFilePath(be, body.path));
    try {
      // Open without O_CREAT before truncating. If a move won the race, this fails instead of
      // recreating the old path; if the open won, the descriptor follows the same inode through
      // the move and the content lands at its new name.
      const handle = await fs.open(resolved, "r+");
      try {
        await handle.truncate(0);
        await handle.writeFile(body.content, "utf-8");
      } finally {
        await handle.close();
      }
    } catch (writeErr) {
      const code = (writeErr as NodeJS.ErrnoException).code;
      if ((code === "EACCES" || code === "EPERM") && be.writeFallback) {
        await be.writeFallback(resolved, body.content);
      } else {
        throw writeErr;
      }
    }
    await be.afterWrite?.(`saved ${path.basename(resolved)}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logFileRouteError(log, err, { path: body.path }, "PUT file failed");
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "File was moved or deleted before it could be saved" }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function deleteFileContent(req: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child(be.logContext);
  try {
    const resolved = await assertInsideWorkspace(be.dir, filePath);
    await fs.access(path.dirname(resolved), fs.constants.W_OK).catch(() => {
      throw new Error("Directory is not writable");
    });
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      await fs.rm(resolved, { recursive: true });
    } else {
      await fs.unlink(resolved);
    }
    await be.afterWrite?.(`deleted ${path.basename(resolved)}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logFileRouteError(log, err, { filePath }, "DELETE file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
