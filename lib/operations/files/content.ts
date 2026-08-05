// File content operations for a workspace or a drive: read one entry, overwrite one text file, remove
// one entry. HTTP-agnostic on purpose — these take a root directory and a wire-space relative path,
// return plain values, and throw AppError.
//
// They used to be Request -> Response (the old lib/files/content.ts), which meant the only way to
// read a file was to build an HTTP request. That blocked three things this shape allows: a directory
// transfer, which is N of these calls and cannot synthesize N fake Requests; testing the rules
// without a server; and reuse by an agent tool, which has no Request to hand over.
//
// The transport concerns that genuinely belong to HTTP — status codes, raw byte responses, logging —
// stay in lib/api/fileContentRoutes.ts.

import fs from "fs/promises";
import path from "path";
import { AppError } from "@/lib/errors/appError";
import { fileSystemAppError, fileSystemCall } from "./errors";
import { resolveHostPath } from "./paths";

/** Hooks a backend contributes. A drive supplies neither: it is passive host storage. */
export interface FileWriteHooks {
  /**
   * Overwrite through the container when the host write is refused. Only legacy root-owned files
   * (created before the non-root migration and not yet swept) need this. Receives the wire-space
   * relative path, since that is what the container's own /workspace view is relative to.
   *
   * It must never create a missing path — see writeTextFile's O_CREAT note.
   */
  writeFallback?: (relPath: string, content: Uint8Array) => Promise<void>;
  /** Git snapshot hook. Failure here must not invalidate a write that already reached disk. */
  afterWrite?: (message: string) => Promise<void>;
}

export type ClassifiedFile =
  | { type: "image"; mimeType: string; bytes: Buffer }
  | { type: "text"; content: string; bytes: Buffer }
  | { type: "binary"; bytes: Buffer };

async function classifyBuffer(bytes: Buffer): Promise<ClassifiedFile> {
  const { fileTypeFromBuffer } = await import("file-type");
  const result = await fileTypeFromBuffer(bytes);

  if (result) {
    if (result.mime.startsWith("image/")) return { type: "image", mimeType: result.mime, bytes };
    return { type: "binary", bytes };
  }

  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // SVG is text-based XML — classify as an image so the viewer renders it rather than showing markup.
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<svg") || (trimmed.startsWith("<?xml") && content.includes("<svg"))) {
      return { type: "image", mimeType: "image/svg+xml", bytes };
    }
    return { type: "text", content, bytes };
  } catch {
    return { type: "binary", bytes };
  }
}

/**
 * Read one file and classify it as text, image or binary. Always returns the bytes as well, since the
 * file has been read either way and a raw-byte response would otherwise read it twice.
 */
export async function readFileEntry(rootDir: string, relPath: string): Promise<ClassifiedFile> {
  const hostPath = await resolveHostPath(rootDir, relPath);
  const bytes = await fileSystemCall(relPath, () => fs.readFile(hostPath));
  return classifyBuffer(bytes);
}

/**
 * Overwrite an existing text file. Deliberately never creates one: it opens without O_CREAT so a save
 * racing a move fails instead of resurrecting the old path. If the open won the race, the descriptor
 * follows the same inode through the move and the content lands at the file's new name.
 *
 * Any future caller that needs create-on-save must add it deliberately, not by relaxing these flags.
 */
export async function writeTextFile(
  rootDir: string,
  relPath: string,
  content: string,
  hooks: FileWriteHooks = {},
): Promise<void> {
  const hostPath = await resolveHostPath(rootDir, relPath);
  try {
    const handle = await fs.open(hostPath, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(content, "utf-8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === "EACCES" || code === "EPERM") && hooks.writeFallback) {
      await fileSystemCall(relPath, () => hooks.writeFallback!(relPath, Buffer.from(content, "utf-8")));
    } else if (code === "ENOENT") {
      // Deliberately not the classifier's NOT_FOUND: on a write, a path that is not there means the
      // save lost a race to a move, which the client resolves by reloading rather than by retrying.
      throw new AppError("CONFLICT", "File was moved or deleted before it could be saved", { field: "path" });
    } else {
      throw fileSystemAppError(err, relPath) ?? err;
    }
  }
  await hooks.afterWrite?.(`saved ${path.basename(relPath)}`);
}

/** Remove one file, or one directory and everything under it. */
export async function removeEntry(rootDir: string, relPath: string, hooks: FileWriteHooks = {}): Promise<void> {
  const hostPath = await resolveHostPath(rootDir, relPath);
  // Checked up front so an unwritable parent is reported as such, rather than as whichever errno the
  // unlink below happens to raise once part of a recursive removal has already succeeded.
  const parent = path.posix.dirname(relPath);
  await fileSystemCall(parent === "." ? "The workspace root" : parent, () =>
    fs.access(path.dirname(hostPath), fs.constants.W_OK),
  );

  const stat = await fileSystemCall(relPath, () => fs.stat(hostPath));
  await fileSystemCall(relPath, () =>
    stat.isDirectory() ? fs.rm(hostPath, { recursive: true }) : fs.unlink(hostPath),
  );
  await hooks.afterWrite?.(`deleted ${path.basename(relPath)}`);
}
