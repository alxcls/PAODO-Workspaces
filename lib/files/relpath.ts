// The one path space the file API speaks: relative to the root of whatever it is serving —
// a workspace or a drive — POSIX-separated, that root spelled "".
//
// It used to speak two. The file tree served absolute host paths, the browser handed them straight
// back, and PUT alone also accepted a relative path (the old backend.lexicalFilePath). That works
// while the only client is a UI that treats the string as an opaque row key, but it makes the host's
// directory layout part of the public contract — the same layout lib/operations/workspace/read.ts
// deliberately keeps out of WorkspaceDetails — and it leaves an external client no way to name a file
// at all, since it cannot know the host dir. One space, chosen here, and the host path stays private
// to the server.
//
// This module is lexical only: it decides what a caller is allowed to *say*, not what exists on disk.
// The filesystem half — realpath'ing away a symlink that points out of the tree — is
// ./containment.ts resolveContained, and both run on every request. A lexical check alone would pass
// "escape/passwd" where `escape` is a symlink to /etc.
//
// Callers in lib/operations/files/paths.ts turn these failures into AppError; kept separate so this
// stays a pure function of its input and can be tested without a workspace or an HTTP request.

import path from "path";

/**
 * Where the agent's container mounts the workspace. Named here because it is the single most likely
 * thing a caller gets wrong: an agent that has been editing /workspace/src/main.ts through its own
 * tools will reach for that same string here, and it deserves an answer that names the right form
 * rather than a bare "invalid path".
 */
export const CONTAINER_MOUNT = "/workspace";

/** A path a caller is not allowed to say. Lexical only — see resolveContained for the disk half. */
export class InvalidPathError extends Error {
  constructor(
    readonly attemptedPath: string,
    reason: string,
  ) {
    super(reason);
    this.name = "InvalidPathError";
  }
}

function reject(attemptedPath: string, reason: string): never {
  throw new InvalidPathError(attemptedPath, reason);
}

/**
 * Normalize a caller-supplied path into the wire space. Returns "" for the root; every other result
 * is a relative POSIX path with no "." or ".." segments and no trailing slash, so it is usable as a
 * stable identity key as well as a path.
 */
function normalizeClientPath(clientPath: string): string {
  const trimmed = clientPath.trim();

  // fs rejects these with ERR_INVALID_ARG_VALUE, which carries no errno and would surface as a 500.
  if (trimmed.includes("\0")) reject(clientPath, "A path cannot contain a null byte");

  if (trimmed === CONTAINER_MOUNT || trimmed.startsWith(`${CONTAINER_MOUNT}/`)) {
    const suggestion = trimmed.slice(CONTAINER_MOUNT.length + 1) || ".";
    reject(
      clientPath,
      `Paths are relative to the root — drop the "${CONTAINER_MOUNT}/" prefix and use "${suggestion}"`,
    );
  }
  if (trimmed.startsWith("/")) {
    reject(clientPath, "Paths must be relative to the root, not absolute");
  }

  // normalize collapses "a//b", "./a" and "a/b/../c"; it leaves a leading ".." in place, which is
  // exactly the escape we then refuse. It also preserves a trailing slash, so "src/" and "src" would
  // otherwise be two different identity keys for one directory — strip it before anything reads the
  // result, including the root check below ("./" normalizes to "./", not ".").
  const normalized = path.posix.normalize(trimmed).replace(/\/$/, "");
  if (normalized === "" || normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    reject(clientPath, "Path escapes the root");
  }
  return normalized;
}

/**
 * A path that must name an entry inside the space. The root is refused: every caller of this reads,
 * writes or deletes one thing, and "" reaching fs.rm would take the whole workspace or drive with it.
 */
export function relativeEntryPath(clientPath: string): string {
  const relPath = normalizeClientPath(clientPath);
  if (relPath === "") reject(clientPath, "Path names the root, not an entry inside it");
  return relPath;
}

/** A directory path, where the root is a legitimate answer. `null`/`undefined`/"."/"" all mean root. */
export function relativeDirPath(clientPath: string | null | undefined): string {
  if (clientPath === null || clientPath === undefined) return "";
  return normalizeClientPath(clientPath);
}

/**
 * The wire path for an absolute host path known to sit under `rootDir` — the direction the file tree
 * and the filesystem watcher need, since both start from what the OS handed them. Returns "" for
 * `rootDir` itself.
 */
export function toRelativePath(rootDir: string, absPath: string): string {
  const relative = path.relative(rootDir, absPath);
  return relative === "" ? "" : relative.split(path.sep).join("/");
}
