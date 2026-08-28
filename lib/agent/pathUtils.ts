// Path containment guard for agent file tools.
//
// normalizeRelpath/normalizeDirPath are a cheap synchronous lexical pre-check (worth rejecting "../"
// before any I/O) but cannot see a symlink planted inside the workspace tree that redirects a
// subpath elsewhere on disk. resolveWorkspacePath goes further: it realpaths the workspace tree the
// same way the HTTP upload route does (lib/files/containment.ts), catching that case too.
// The workspace's host-visible directory and the sandbox container's /workspace mount are the same
// filesystem — one named Docker volume, mounted whole into the app and by subpath into the sandbox,
// in every mode — so a host-side check here validly covers what a container-side write would do.

import path from "path";
import { resolveContained } from "@/lib/files/containment";

// The container's own name for the workspace root. The system prompt tells the agent /workspace is
// its working directory and execute_command takes absolute paths there, so it forms them for the
// file tools too — a correct path that used to be rejected as an escape.
const CONTAINER_ROOT = "/workspace";

// Trims CONTAINER_ROOT off an already-normalized absolute path, or returns null if it addresses
// anything else. Only ever called post-normalize, so "/workspace/../etc/passwd" has already
// collapsed to "/etc/passwd" and cannot match; "/workspacefoo" fails the segment boundary.
// Returns "" for the root itself, which each caller interprets for its own path kind.
function trimContainerRoot(normalized: string): string | null {
  if (normalized === CONTAINER_ROOT) return "";
  if (!normalized.startsWith(`${CONTAINER_ROOT}/`)) return null;
  return normalized.slice(CONTAINER_ROOT.length + 1).replace(/\/+$/, "");
}

export function normalizeRelpath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath);
  // "" means the caller named the workspace root, which is a directory, never a file.
  if (normalized.startsWith("/")) return trimContainerRoot(normalized) || null;
  return normalized.startsWith("..") ? null : normalized;
}

export function normalizeDirPath(dirPath: string | undefined): string | null {
  if (!dirPath || dirPath === ".") return ".";
  const normalized = path.posix.normalize(dirPath);
  if (normalized.startsWith("/")) {
    const trimmed = trimContainerRoot(normalized);
    return trimmed === null ? null : trimmed || ".";
  }
  return normalized.startsWith("..") ? null : normalized;
}

/**
 * Realpath-based containment check for a workspace path. `workspaceDir` is the host path for the
 * workspace (not the container's `/workspace` view, which `relpath` may itself be expressed in).
 * Returns null if `relpath` escapes — via `..`, an absolute path outside `/workspace`, or a symlink
 * anywhere along the way.
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
