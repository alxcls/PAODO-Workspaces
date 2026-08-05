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

const BY_ERRNO: Record<string, Classification> = {
  ENOENT: { code: "NOT_FOUND", message: (p) => `${p} does not exist` },
  EISDIR: { code: "INVALID_REQUEST", message: (p) => `${p} is a directory, not a file` },
  ENOTDIR: { code: "INVALID_REQUEST", message: (p) => `${p} is not a directory` },
  ENOTEMPTY: { code: "CONFLICT", message: (p) => `${p} is not empty` },
  EEXIST: { code: "CONFLICT", message: (p) => `${p} already exists` },

  // Retrying cannot help until someone changes the permissions, so this is not a 400 asking the
  // client to fix its request. Kept distinct from FORBIDDEN, which means "you are not authorised" —
  // a client that conflates the two would sign the user out over a read-only directory.
  EACCES: { code: "FILE_NOT_WRITABLE", message: (p) => `${p} is not writable` },
  EPERM: { code: "FILE_NOT_WRITABLE", message: (p) => `${p} is not writable` },
  EROFS: { code: "FILE_NOT_WRITABLE", message: () => "The filesystem is read-only" },

  ENOSPC: { code: "INSUFFICIENT_STORAGE", message: () => "Not enough free disk space" },
  EDQUOT: { code: "INSUFFICIENT_STORAGE", message: () => "The disk quota is exhausted" },
  EFBIG: { code: "PAYLOAD_TOO_LARGE", message: (p) => `${p} is larger than the filesystem allows` },
  ENAMETOOLONG: { code: "INVALID_REQUEST", message: (p) => `${p} is too long a path for this filesystem` },
  ELOOP: { code: "INVALID_REQUEST", message: (p) => `${p} is a symlink loop` },

  // Transient and worth retrying, unlike everything above: the descriptor budget (lib/files/fdLimit.ts)
  // keeps our own traversals under the limit, but nothing stops the rest of the process from using it up.
  EMFILE: { code: "SERVICE_UNAVAILABLE", message: () => "The server is out of file descriptors — retry" },
  ENFILE: { code: "SERVICE_UNAVAILABLE", message: () => "The server is out of file descriptors — retry" },
  EBUSY: { code: "CONFLICT", message: (p) => `${p} is in use` },
  EAGAIN: { code: "SERVICE_UNAVAILABLE", message: () => "The file is temporarily unavailable — retry" },
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
