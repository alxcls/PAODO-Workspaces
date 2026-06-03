import path from "path";

// Normalizes a caller-supplied relative path and guards against directory traversal.
// Uses path.posix because container paths are always POSIX regardless of dev host OS.
// Returns null if the path escapes the workspace root.
export function normalizeRelpath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}

// Pure lock check against a pre-fetched permission snapshot — avoids N disk reads for N entries.
// Checks prefix ancestors so that locking a directory locks everything inside it.
export function isLockedFromSnapshot(
  snapshot: { globalLock: boolean; locked: string[] },
  relPath: string,
): boolean {
  if (snapshot.globalLock) return true;
  const parts = relPath.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (snapshot.locked.includes(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}
