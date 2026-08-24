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
  type ClassifiedFile,
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

// Raster formats a browser paints and cannot execute. An allowlist, so a document format the detector
// learns next release is inert until added here — which is why SVG is absent rather than filtered.
const RENDERABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/tiff",
  "image/jp2",
  "image/jxl",
  "image/heic",
  "image/heif",
]);

// What ?raw=1 says a body is. Text is named apart from binary so `paodo file cat`, which has only
// the headers, can refuse a PNG before writing it to a terminal.
function rawMediaType(file: ClassifiedFile): string {
  if (file.type === "image" && RENDERABLE_IMAGE_TYPES.has(file.mimeType)) return file.mimeType;
  return file.type === "text" ? "text/plain; charset=utf-8" : "application/octet-stream";
}

// RFC 6266: ASCII-folded in the quoted form, real name percent-encoded in filename*. A quote or a
// newline in a filename can no longer end the header early or inject another.
function attachmentDisposition(relPath: string): string {
  const name = path.basename(relPath);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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

    // ?raw=1 — serve the bytes themselves, for <img src>, download links and `paodo file cat`.
    if (searchParams.get("raw") === "1") {
      const isDownload = searchParams.get("download") === "1";
      const bytes = windowed === undefined ? file.bytes : Buffer.from(windowed, "utf-8");
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": rawMediaType(file),
          // The type above is decided from the bytes, so sniffing can only override it downward.
          "X-Content-Type-Options": "nosniff",
          ...(isDownload ? { "Content-Disposition": attachmentDisposition(relPath) } : {}),
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
    const receipt = await removeEntry(be.dir, relPath, be);
    // The path that was removed, for the reason a write reports one — more so here, since this is the
    // verb where acting on a path other than the one you meant cannot be undone. `removed` is the same
    // answer for a directory, where the one path a caller named stands for a whole tree it never listed
    // and now cannot: naming the tree is the only chance to see what a recursive delete actually took.
    return NextResponse.json({ ok: true, path: relPath, ...receipt });
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
