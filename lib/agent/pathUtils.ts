// Path containment guard for agent file tools. Both functions enforce that a
// requested path resolves inside the workspace root — no traversal, no absolute paths.

import path from "path";

export function normalizeRelpath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}

export function normalizeDirPath(dirPath: string | undefined): string | null {
  if (!dirPath || dirPath === ".") return ".";
  const normalized = path.posix.normalize(dirPath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}
