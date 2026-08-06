// The HTTP shape of the file-content endpoint, shared by the workspace and drive routes. Everything
// here is transport: read the path off the query string or body, call the operation, and turn the
// result into a status and a body. The rules live in lib/operations/files/content.ts.
//
// Paths in and out are workspace-relative (lib/files/relpath.ts). A client names "src/main.ts"; the
// host directory never appears in a request or a response.
//
// Each verb spells out its own two branches — the expected AppError through appErrorResponse, then one
// literal log record and an opaque 500 — rather than sharing a helper for the second one. That is the
// convention lib/api/errorResponse.ts describes, and the reason is that an operator greps an event name
// to find the code that raised it: a shared `file_operation_failed` with the verb in a field passes the
// errorLogContract check and defeats what the check is for.
import { NextResponse } from "next/server";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { AppError } from "@/lib/errors/appError";
import type { FileBackend } from "@/lib/files/backend";
import {
  readFileEntry,
  removeEntry,
  requireLineRange,
  sliceLines,
  writeTextFile,
} from "@/lib/operations/files/content";
import { requireEntryPath } from "@/lib/operations/files/paths";

/** The opaque answer for a failure the operations layer had no public code for, so it is ours to fix. */
function internalFailure(request: Request): NextResponse {
  return errorResponse("INTERNAL_ERROR", "The file operation failed", { request });
}

export async function getFileContent(request: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const log = createLogger("api").child(be.logContext);
  let relPath: string | undefined;
  try {
    relPath = requireEntryPath(searchParams.get("path"));
    // ?offset= and ?limit= — part of a text file, in lines. Read before the file so a range a caller
    // cannot ask for is refused without reading anything, and absent from both branches below when the
    // caller named neither, which is every request the file panel makes.
    const range = requireLineRange(searchParams.get("offset"), searchParams.get("limit"));
    const file = await readFileEntry(be.dir, relPath);
    if (range && file.type !== "text") {
      // Refused rather than served whole or sliced anyway: a line is a thing only text has, and a
      // caller that asked for twenty lines of a PNG has misunderstood the file, not the parameter. The
      // whole PNG in answer to that is the expensive way to find out.
      throw new AppError("INVALID_REQUEST", `${relPath} is not a text file, so it has no lines to read`, {
        field: "offset",
      });
    }
    const windowed = file.type === "text" && range ? sliceLines(file.content, range) : undefined;

    // ?raw=1 — serve the bytes themselves, for <img src> and download links.
    if (searchParams.get("raw") === "1") {
      const mime = file.type === "image" ? file.mimeType : "application/octet-stream";
      const isDownload = searchParams.get("download") === "1";
      const bytes = windowed === undefined ? file.bytes : Buffer.from(windowed, "utf-8");
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": mime,
          ...(isDownload ? { "Content-Disposition": `attachment; filename="${path.basename(relPath)}"` } : {}),
        },
      });
    }

    if (file.type === "text") return NextResponse.json({ type: "text", content: windowed ?? file.content });
    return NextResponse.json({ type: file.type });
  } catch (err) {
    const known = appErrorResponse(err, request);
    if (known) return known;
    log.error(
      { event: "file_read_failed", outcome: "file_not_returned", code: "INTERNAL_ERROR", err, relPath },
      "failed to read file",
    );
    return internalFailure(request);
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
    // Names what it wrote. `{ ok: true }` alone left the caller to assume the path it sent is the one
    // that was acted on, which is exactly the assumption a normalized path ("./src/main.ts", "src//main.ts")
    // can quietly break — and the receipt is where that is cheap to see rather than expensive to discover.
    return NextResponse.json({ ok: true, path: relPath });
  } catch (err) {
    const known = appErrorResponse(err, request);
    if (known) return known;
    log.error(
      { event: "file_write_failed", outcome: "file_not_written", code: "INTERNAL_ERROR", err, relPath },
      "failed to write file",
    );
    return internalFailure(request);
  }
}

export async function deleteFileContent(request: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const log = createLogger("api").child(be.logContext);
  let relPath: string | undefined;
  try {
    relPath = requireEntryPath(searchParams.get("path"));
    await removeEntry(be.dir, relPath, be);
    // The path that was removed, for the reason a write reports one — more so here, since this is the
    // verb where acting on a path other than the one you meant cannot be undone.
    return NextResponse.json({ ok: true, path: relPath });
  } catch (err) {
    const known = appErrorResponse(err, request);
    if (known) return known;
    log.error(
      { event: "file_delete_failed", outcome: "file_not_deleted", code: "INTERNAL_ERROR", err, relPath },
      "failed to delete file",
    );
    return internalFailure(request);
  }
}
