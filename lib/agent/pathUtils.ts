// Path containment guard for agent file tools.
//
// normalizeRelpath/normalizeDirPath are a cheap synchronous lexical pre-check (worth rejecting "../"
// before any I/O) but cannot see a symlink planted inside the workspace tree that redirects a
// subpath elsewhere on disk. resolveWorkspacePath goes further: it realpaths the workspace tree the
// same way the HTTP upload route does (lib/files/containment.ts), catching that case too.
// The workspace's host-visible directory and the sandbox container's /workspace mount are the same
// filesystem (same Docker volume in prod, same bind mount in local dev), so a host-side check here
// validly covers what a container-side `docker exec ... tee /workspace/<relpath>` would actually do.

import path from "path";
import { resolveContained } from "@/lib/files/containment";

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

/**
 * Realpath-based containment check for a workspace-relative path. `workspaceDir` is the host path
 * for the workspace (not the container's `/workspace` view). Returns null if `relpath` escapes — via
 * `..`, an absolute path, or a symlink anywhere along the way.
 */
export async function resolveWorkspacePath(workspaceDir: string, relpath: string): Promise<string | null> {
  const normalized = normalizeRelpath(relpath);
  if (normalized === null) return null;
  return resolveContained(workspaceDir, normalized);
}

/**
 * Normalize a caller-supplied file path and realpath-contain it in one step — the check every
 * write tool (file_write, file_edit) needs before touching disk. Returns the normalized,
 * workspace-relative path, or null if it escapes lexically or via a symlink.
 */
export async function containWorkspacePath(workspaceDir: string, filePath: string): Promise<string | null> {
  const relpath = normalizeRelpath(filePath);
  if (relpath === null) return null;
  return (await resolveWorkspacePath(workspaceDir, relpath)) === null ? null : relpath;
}
