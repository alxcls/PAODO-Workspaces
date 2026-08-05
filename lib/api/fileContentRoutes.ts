// The HTTP shape of the file-content endpoint, shared by the workspace and drive routes. Everything
// here is transport: read the path off the query string or body, call the operation, and turn the
// result into a status and a body. The rules live in lib/operations/files/content.ts.
//
// Paths in and out are workspace-relative (lib/files/relpath.ts). A client names "src/main.ts"; the
// host directory never appears in a request or a response.
import { NextResponse } from "next/server";
import path from "path";
import type pino from "pino";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import type { FileBackend } from "@/lib/files/backend";
import { readFileEntry, removeEntry, writeTextFile } from "@/lib/operations/files/content";
import { requireEntryPath } from "@/lib/operations/files/paths";

/**
 * The two branches every verb below spells out, per the convention in lib/api/errorResponse.ts: the
 * expected AppError through appErrorResponse, then one literal log record and an opaque 500.
 *
 * Reaching the second branch means an errno lib/operations/files/errors.ts has no entry for, so it is
 * ours to fix rather than the client's — which is why the response says nothing specific. It used to
 * be a 400 carrying `err.message`, and libuv writes the host path into that message.
 */
function failure(request: Request, err: unknown, log: pino.Logger, verb: string, relPath?: string): Response {
  const known = appErrorResponse(err, request);
  if (known) return known;
  log.error(
    { event: "file_operation_failed", outcome: "file_unchanged", err, verb, relPath },
    "unclassified file operation failure",
  );
  return errorResponse("INTERNAL_ERROR", "The file operation failed", { request });
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
    return failure(request, err, log, "GET", relPath);
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
    return failure(request, err, log, "PUT", relPath);
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
    return failure(request, err, log, "DELETE", relPath);
  }
}
