// Shared upload handler for the workspace and drive upload routes. One request writes one file,
// whose destination comes from the `?path=` query param.
//
// The body is streamed to disk and never buffered. The container has less RAM than MAX_UPLOAD_BYTES,
// so reading an upload into a Buffer would OOM the process long before the limit was reached. This is
// also why the browser uploads a folder as N of these one-file requests (see
// lib/client/hooks/useFileUpload.ts) rather than one archive: it keeps memory flat on both ends, lets
// each file fail and retry on its own, and removes the zip-slip surface that caller-named archive
// entries otherwise create.
//
// One path does extract a caller-authored archive server-side — the CLI's tar transfer
// (lib/operations/files/transfer.ts) — and it is worth being exact about which of the three reasons
// above it answers. Memory: it streams entry by entry to a staging directory, so it is as flat as this
// handler. Zip-slip: entry names are normalised and every one must resolve inside a single virtual
// `payload` root, and only regular files and directories are accepted. Per-file retry: it has none, and
// that is the trade — one request is what makes the transfer atomic, which a scripted client wants more
// than resumability, and a browser on a flaky connection wants far less.
//
// Containment: the target directory is realpath'd once, then the write target is resolved against it
// via the shared resolveContained() helper (lib/files/containment.ts — also used by the
// agent's own file tools) and must stay under it. Bytes land in a sibling temp file that is renamed
// into place only once the whole body has arrived, so an interrupted or over-limit upload cannot
// leave a truncated file at the real path. The two callers differ only in the optional `afterWrite`
// git snapshot (workspaces take one; drives are passive host storage and do not).
import { type NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { randomBytes } from "crypto";
import { createLogger } from "@/lib/infra/logger";
import { MAX_UPLOAD_BYTES, formatBytes } from "@/lib/uploads/limits";
import { checkFreeSpace, RESERVED_FREE_BYTES } from "@/lib/infra/storage/diskSpace";
import { resolveContained } from "@/lib/files/containment";
import { requireEntryPath } from "@/lib/operations/files/paths";
import { fileSystemAppError } from "@/lib/operations/files/errors";
import { AppError } from "@/lib/errors/appError";
import { errorResponse } from "@/lib/api/errorResponse";

export interface UploadBackend {
  dir: string;
  logContext: Record<string, unknown>;
  // Called after a successful upload (workspace git snapshot) with the written file's name. The
  // backend owns the commit message, because only it knows whether this file is one of a burst.
  afterWrite?: (fileName: string) => Promise<void>;
}

/** Thrown by the counting stage below when a body runs past the limit mid-transfer. */
class PayloadTooLargeError extends Error {
  constructor(readonly receivedBytes: number) {
    super("payload too large");
  }
}

export async function handleUpload(req: NextRequest, be: UploadBackend): Promise<Response> {
  const log = createLogger("api");
  const limitLabel = formatBytes(MAX_UPLOAD_BYTES);

  // One helper builds both the log record and the response body so they can never disagree about
  // why the upload was refused. `rejectedAt` distinguishes the cheap up-front Content-Length
  // rejection from the authoritative mid-stream one.
  const tooLarge = (filePath: string, actualBytes: number, rejectedAt: "content_length" | "stream") => {
    log.warn(
      {
        ...be.logContext,
        event: "upload_payload_too_large",
        outcome: "upload_rejected",
        filePath,
        actualBytes,
        limitBytes: MAX_UPLOAD_BYTES,
        rejectedAt,
      },
      // Static message with the sizes in fields, so the line stays greppable and aggregatable; the
      // human-readable rendering belongs in the response the user actually reads.
      "upload rejected — payload exceeds the per-file upload limit",
    );
    return errorResponse(
      "FILE_TOO_LARGE",
      `File is ${formatBytes(actualBytes)}, which is over the ${limitLabel} per-file upload limit.`,
      { request: req, details: { field: "path", limitBytes: MAX_UPLOAD_BYTES } },
    );
  };

  // Distinct from tooLarge: this file may be well within the per-file limit, but the host itself
  // is out of room. Telling the two apart matters because one is the user's problem and the other
  // is ours.
  const insufficientStorage = (filePath: string, neededBytes: number, freeBytes: number) => {
    log.error(
      {
        ...be.logContext,
        event: "upload_insufficient_storage",
        outcome: "upload_rejected",
        filePath,
        neededBytes,
        freeBytes,
      },
      "upload rejected — not enough free disk space",
    );
    return errorResponse("STORAGE_EXHAUSTED", "Not enough free disk space to accept this upload.", {
      request: req,
    });
  };

  // `?path=` is workspace-relative, and requireEntryPath is what makes that the only thing it can be:
  // resolveContained alone would still accept an absolute path that happened to land inside the root,
  // which is the dual path space the rest of the file API no longer has (lib/files/relpath.ts).
  const { searchParams } = new URL(req.url);
  let filePath: string;
  try {
    filePath = requireEntryPath(searchParams.get("path"));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return errorResponse(err.code, err.message, { request: req, details: err.details });
  }

  const dir = await fs.realpath(be.dir);
  const resolved = await resolveContained(dir, filePath);
  if (resolved === null) {
    return errorResponse("INVALID_REQUEST", "Path resolves outside the workspace", {
      request: req,
      details: { field: "path" },
    });
  }

  // Refuse on the declared size before reading a byte. Browsers always set Content-Length for a
  // File body, so this is the path a real oversized upload takes — and it avoids spooling the
  // whole doomed body to disk first.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return tooLarge(filePath, declared, "content_length");
  }

  // Chunked bodies declare no length, so assume the worst case (the per-file cap) rather than
  // skip the check — same conservative stance the size limit above takes.
  const neededBytes = Number.isFinite(declared) && declared > 0 ? declared : MAX_UPLOAD_BYTES;
  const space = await checkFreeSpace(dir, neededBytes, RESERVED_FREE_BYTES);
  if (!space.ok) return insufficientStorage(filePath, neededBytes, space.freeBytes);

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  // Temp sibling in the destination directory, so it shares a filesystem and the rename is atomic.
  const tmp = `${resolved}.${randomBytes(6).toString("hex")}.part`;

  try {
    await pipeline(
      // Cast: NextRequest.body is a web ReadableStream, which Readable.fromWeb accepts but does not
      // share a nominal type with. A bodyless POST still writes a legitimate empty file.
      req.body ? Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([]),
      async function* count(source) {
        let received = 0;
        for await (const chunk of source) {
          received += (chunk as Buffer).length;
          // Content-Length is absent on chunked bodies and can simply lie, so this is the check
          // that actually holds the limit.
          if (received > MAX_UPLOAD_BYTES) throw new PayloadTooLargeError(received);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    await fs.rename(tmp, resolved);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    if (err instanceof PayloadTooLargeError) return tooLarge(filePath, err.receivedBytes, "stream");
    log.error(
      {
        ...be.logContext,
        event: "uploaded_file_write_failed",
        outcome: "file_not_written",
        err,
        filePath,
      },
      "failed to write uploaded file",
    );
    // Logged either way — a write that got this far failing is worth a line even when the cause is the
    // client's — but a recognised errno still answers with its own code, so a full disk mid-stream is
    // not indistinguishable from a bug.
    const known = fileSystemAppError(err, filePath);
    return known
      ? errorResponse(known.code, known.message, { request: req, details: known.details })
      : errorResponse("INTERNAL_ERROR", "The upload could not be written", { request: req });
  }

  await be.afterWrite?.(path.basename(resolved));
  return NextResponse.json({ ok: true });
}
