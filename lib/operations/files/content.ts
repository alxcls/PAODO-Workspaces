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
 * A window of a text file's lines: `offset` is a 0-based line index, `limit` a count of lines, so
 * `{ offset: 49, limit: 50 }` is lines 50–99 as an editor numbers them.
 *
 * Deliberately the same vocabulary the workspace agent's own read tool takes (lib/agent/tools/
 * fileRead.ts): the same file gets read for the same reason from inside the container and over the API,
 * and two spellings of "offset" is one for a caller to guess wrong with nothing in the answer to say so.
 */
export interface LineRange {
  offset: number;
  limit?: number;
}

/** Absent, or an integer no smaller than `min`. Absent is undefined only — see requireLineRange. */
function requireCount(value: unknown, field: string, min: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  // An empty parameter is a caller that sent it and left it blank, which is not the same as omitting
  // it: Number("") is 0, and for `offset` that would silently mean "from the top of the file".
  const count = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < min) {
    throw new AppError("INVALID_REQUEST", `${field} must be a whole number of at least ${min}`, { field });
  }
  return count;
}

/**
 * The line window a caller asked for, or null for the whole file — which is what both values absent
 * means, so a client that never reads part of a file sends nothing and is unaffected.
 *
 * Here rather than at the route because it is a rule about what may be asked for, and both the
 * workspace and the drive content route ask it. A value that is not a whole number is refused rather
 * than rounded or ignored: an `offset=abc` read as 0 answers with a different part of the file than the
 * caller named, and lines carry nothing that would let the caller notice.
 */
export function requireLineRange(offset: unknown, limit: unknown): LineRange | null {
  const start = requireCount(offset, "offset", 0);
  const count = requireCount(limit, "limit", 1);
  if (start === undefined && count === undefined) return null;
  return { offset: start ?? 0, ...(count === undefined ? {} : { limit: count }) };
}

/**
 * The lines of `content` that `range` names, with their terminators intact.
 *
 * Not normalized: each selected line keeps its own "\n", and a last line that ended without one in the
 * file ends without one here, so a window that runs to the end of a file is byte-identical to that
 * file's tail. A window that starts past the end is empty rather than an error — that is the answer
 * `sed -n` gives, and it is what a caller walking a file in pages reads as "that was all of it".
 */
export function sliceLines(content: string, { offset, limit }: LineRange): string {
  if (content === "") return "";
  const terminated = content.endsWith("\n");
  const lines = content.split("\n");
  // The split's final "" is the terminator, not a line: without this, every window of a normal text
  // file would report one more line than the file has and an offset at the end would return "".
  if (terminated) lines.pop();

  const selected = lines.slice(offset, limit === undefined ? undefined : offset + limit);
  if (selected.length === 0) return "";
  const reachesEnd = offset + selected.length === lines.length;
  return selected.join("\n") + (reachesEnd && !terminated ? "" : "\n");
}

/**
 * How many lines `sliceLines` would find in `content` — the number an `offset` must stay below and the
 * one a `limit` counts against.
 *
 * Here, immediately beside the slicer, because it is the same definition of "a line" and the two are
 * only useful together: a listing reports this so a caller can choose a window, and a window is then
 * applied by the function above. Two definitions of where a line ends would show up as a caller reading
 * one line too many or one too few off the end of every file, which is the kind of wrongness that
 * survives a long time because the content it returns still looks right.
 *
 * So the two agree on the awkward parts. A trailing "\n" is a terminator, not an empty final line, so
 * "a\n" and "a" are both one line. An empty file has no lines at all rather than one empty one, which
 * is what makes `lines: 0` mean "there is nothing here to read".
 */
export function countLines(content: string): number {
  if (content === "") return 0;
  let lines = content.endsWith("\n") ? 0 : 1;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) lines += 1;
  return lines;
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
