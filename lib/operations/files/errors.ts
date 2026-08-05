// One place that turns a filesystem errno into the public error vocabulary.
//
// Every file failure used to leave here as a 400 carrying `err.message`. Two things were wrong with
// that. A program could not tell them apart — a full disk, a permission failure, a directory named
// where a file was expected and a genuinely malformed request all arrived as INVALID_REQUEST, so a CLI
// or an agent had nothing to branch on and no way to know whether retrying could ever work. And
// `err.message` is written by libuv, which appends the path it failed on: "EACCES: permission denied,
// open '/data/workspaces/ada/notes.md'". That is the host layout, in a response, on a route whose whole
// point is that the host layout is private.
//
// So the message is built here from the caller's own relative path, and the errno picks the code. An
// errno with no entry is deliberately NOT given a 4xx: the caller logs it and answers an opaque 500,
// because guessing that an unrecognised failure is the client's fault is how a server bug gets
// reported as a user error.

import { AppError, type AppErrorCode } from "@/lib/errors/appError";

interface Classification {
  code: AppErrorCode;
  /** Built from the relative path the caller named — never from err.message. */
  message: (relPath: string) => string;
}

/**
 * Only errnos a real call path reaches. A first version mapped sixteen, including EDQUOT, EFBIG, ELOOP,
 * EMFILE and EBUSY — added because they sat next to these in the errno list, which is the wrong reason
 * to put something in a vocabulary the codebase promises never to redefine. An unmapped errno is not a
 * gap: it becomes a logged 500, which is the honest answer for a failure nobody has reasoned about yet.
 */
const BY_ERRNO: Record<string, Classification> = {
  // read, stat and unlink of something that is not there.
  ENOENT: { code: "NOT_FOUND", message: (p) => `${p} does not exist` },
  // readFile of a directory.
  EISDIR: { code: "INVALID_REQUEST", message: (p) => `${p} is a directory, not a file` },
  // A path that runs *through* a file, e.g. "notes.txt/inner".
  ENOTDIR: { code: "INVALID_REQUEST", message: (p) => `${p} is not a directory` },

  // Retrying cannot help until someone changes the permissions, so this is not a 400 asking the client
  // to fix its request.
  EACCES: { code: "FILE_NOT_WRITABLE", message: (p) => `${p} is not writable` },
  EPERM: { code: "FILE_NOT_WRITABLE", message: (p) => `${p} is not writable` },

  // A write or an upload that ran the volume out mid-stream.
  ENOSPC: { code: "STORAGE_EXHAUSTED", message: () => "Not enough free disk space" },
};

/**
 * The AppError for a filesystem failure, or `null` when the errno has no public meaning — in which
 * case the caller must log it with a literal event and answer an opaque 500.
 *
 * `relPath` is the workspace-relative path the caller named, so the message says what the client asked
 * about rather than where it happens to live on the host.
 */
export function fileSystemAppError(err: unknown, relPath: string): AppError | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== "string") return null;
  const classification = BY_ERRNO[code];
  if (!classification) return null;
  return new AppError(classification.code, classification.message(relPath), { field: "path" });
}

/**
 * Run a filesystem operation, translating any errno it raises. Use this rather than a bare fs call so
 * a new operation cannot accidentally reintroduce the raw-errno-out-the-door behaviour.
 */
export async function fileSystemCall<T>(relPath: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw fileSystemAppError(err, relPath) ?? err;
  }
}
