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
