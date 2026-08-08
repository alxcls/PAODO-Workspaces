// Server-only free-space check, split out from uploadLimits.ts (which stays client-bundleable and
// therefore free of fs imports) so it can be unit-tested in isolation.
import fs from "fs/promises";

/**
 * Free space every write path (upload, execute_command, file_write/file_edit) must keep beyond
 * what it needs. There is no aggregate upload limit, so without this a user dragging in a few
 * large folders — or an agent command like a git clone — could run the host's disk to zero,
 * taking down logging, git, and the sqlite store for every workspace, not just theirs. Same round
 * number as MAX_UPLOAD_BYTES so the two read as one policy.
 */
export const RESERVED_FREE_BYTES = 1024 * 1024 * 1024; // 1 GB

export interface FreeSpaceCheck {
  ok: boolean;
  freeBytes: number;
}

/**
 * Whether `dir`'s filesystem has room for `neededBytes` plus `reservedBytes` of headroom. `dir`
 * must already exist — callers realpath it first for the same reason the upload path containment
 * check does.
 */
export async function checkFreeSpace(dir: string, neededBytes: number, reservedBytes: number): Promise<FreeSpaceCheck> {
  const stats = await fs.statfs(dir);
  const freeBytes = stats.bavail * stats.bsize;
  return { ok: freeBytes >= neededBytes + reservedBytes, freeBytes };
}

/**
 * Free-space guard for the write tools that report failure as a plain "Error: ..." string
 * (containerWrite's create path, file_edit's edit branch) — collapses the check-then-message
 * pattern those two call sites duplicated. The HTTP upload route and execute_command need their
 * own response shape (JSON 507 / kill-with-reason) and call checkFreeSpace directly instead.
 */
export async function requireFreeSpace(dir: string, neededBytes: number): Promise<string | null> {
  const space = await checkFreeSpace(dir, neededBytes, RESERVED_FREE_BYTES);
  return space.ok ? null : "Error: not enough free disk space to write this file.";
}
