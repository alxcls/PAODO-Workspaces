// Where a caller-supplied path becomes a host path, or an AppError explaining why it cannot.
//
// Two checks, always both, in this order:
//   1. lexical  — lib/files/relpath.ts: is the caller allowed to say this? (relative, no "..", no
//      "/workspace/" prefix). Cheap, and worth refusing before any I/O.
//   2. on disk  — lib/files/containment.ts resolveContained: does it still land inside the root once
//      symlinks are resolved? A path that is lexically clean can still point at /etc through a
//      symlink the agent created inside its own workspace.
//
// This is the layer that owns the vocabulary: it turns both failures into AppError so a route never
// inspects a path itself, and so the same rules apply to a UI click, a CLI command and an agent tool
// without three copies of them.

import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { resolveContained } from "@/lib/files/containment";
import { InvalidPathError, relativeDirPath, relativeEntryPath } from "@/lib/files/relpath";

/** `details.field` names which input was wrong, so a client can point at the right argument. */
function invalidPath(error: unknown, field: string): AppError {
  if (error instanceof InvalidPathError) {
    return new AppError("INVALID_REQUEST", error.message, { field });
  }
  throw error;
}

/** Validate a required path naming one entry. Returns the wire-space relative path. */
export function requireEntryPath(value: unknown, field = "path"): string {
  const raw = requireNonEmptyString(value, field);
  try {
    return relativeEntryPath(raw);
  } catch (err) {
    throw invalidPath(err, field);
  }
}

/** Validate an optional directory path. `null`/`undefined` mean the root, and so does "" or ".". */
export function requireDirPath(value: unknown, field = "path"): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw new AppError("INVALID_REQUEST", `${field} must be a string`, { field });
  }
  try {
    return relativeDirPath(value);
  } catch (err) {
    throw invalidPath(err, field);
  }
}

/**
 * Resolve a validated relative path to the absolute host path to act on. Throws rather than returning
 * null: by this point the path has passed the lexical check, so a failure here means a symlink
 * pointing out of the tree — which the caller may not distinguish from a legitimate path, since the
 * file tree lists such a symlink as an ordinary row.
 */
export async function resolveHostPath(rootDir: string, relPath: string, field = "path"): Promise<string> {
  const resolved = await resolveContained(rootDir, relPath);
  if (resolved === null) {
    throw new AppError("INVALID_REQUEST", "Path resolves outside the workspace", { field });
  }
  return resolved;
}
