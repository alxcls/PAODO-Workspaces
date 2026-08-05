// The HTTP shape of the file-content endpoint, shared by the workspace and drive routes. Everything
// here is transport: read the path off the query string or body, call the operation, and turn the
// result into a status and a body. The rules live in lib/operations/files/content.ts.
//
// Paths in and out are workspace-relative (lib/files/relpath.ts). A client names "src/main.ts"; the
// host directory never appears in a request or a response.
import { NextResponse } from "next/server";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { logFileRouteError, type FileBackend } from "@/lib/files/backend";
import { readFileEntry, removeEntry, writeTextFile } from "@/lib/operations/files/content";
import { requireEntryPath } from "@/lib/operations/files/paths";

/**
 * One unexpected-failure branch for all three verbs. The expected AppError path is handled by the
 * caller through appErrorResponse; anything reaching here is an errno we have not classified yet, so
 * it stays a generic 400 with the raw message — the same behaviour as before this module existed.
 *
 * That message can still carry a host path from a bare errno. Classifying errno into the public code
 * vocabulary (EACCES, ENOSPC, EISDIR, ...) is the next piece of work; it is deliberately not folded in
 * here, so this change is a move of the path space and nothing else.
 */
function unexpected(request: Request, err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "Unknown error";
  return errorResponse("INVALID_REQUEST", message, { request });
}

export async function getFileContent(request: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const log = createLogger("api").child(be.logContext);
  let relPath: string | undefined;
  try {
    relPath = requireEntryPath(searchParams.get("path"));
    const file = await readFileEntry(be.dir, relPath);

    // ?raw=1 — serve the bytes themselves, for <img src> and download links.
    if (searchParams.get("raw") === "1") {
      const mime = file.type === "image" ? file.mimeType : "application/octet-stream";
      const isDownload = searchParams.get("download") === "1";
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          "Content-Type": mime,
          ...(isDownload ? { "Content-Disposition": `attachment; filename="${path.basename(relPath)}"` } : {}),
        },
      });
    }

    if (file.type === "text") return NextResponse.json({ type: "text", content: file.content });
    return NextResponse.json({ type: file.type });
  } catch (err) {
    logFileRouteError(log, err, { relPath }, "GET file failed");
    return appErrorResponse(err, request) ?? unexpected(request, err);
  }
}

export async function putFileContent(request: Request, be: FileBackend): Promise<Response> {
  const body = await readJsonObject(request);
  if (body instanceof NextResponse) return body;
  if (typeof body.content !== "string") {
    return errorResponse("INVALID_REQUEST", "content is required", { request, details: { field: "content" } });
  }

  const log = createLogger("api").child(be.logContext);
  let relPath: string | undefined;
  try {
    relPath = requireEntryPath(body.path);
    await writeTextFile(be.dir, relPath, body.content, be);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logFileRouteError(log, err, { relPath }, "PUT file failed");
    return appErrorResponse(err, request) ?? unexpected(request, err);
  }
}

export async function deleteFileContent(request: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const log = createLogger("api").child(be.logContext);
  let relPath: string | undefined;
  try {
    relPath = requireEntryPath(searchParams.get("path"));
    await removeEntry(be.dir, relPath, be);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logFileRouteError(log, err, { relPath }, "DELETE file failed");
    return appErrorResponse(err, request) ?? unexpected(request, err);
  }
}
