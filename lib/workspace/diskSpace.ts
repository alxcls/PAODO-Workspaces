// Server-only free-space check, split out from uploadLimits.ts (which stays client-bundleable and
// therefore free of fs imports) so it can be unit-tested in isolation.
import fs from "fs/promises";

export interface FreeSpaceCheck {
  ok: boolean;
  freeBytes: number;
}

/**
 * Whether `dir`'s filesystem has room for `neededBytes` plus RESERVED_FREE_BYTES of headroom.
 * `dir` must already exist — callers realpath it first for the same reason the upload path
 * containment check does.
 */
export async function checkFreeSpace(dir: string, neededBytes: number, reservedBytes: number): Promise<FreeSpaceCheck> {
  const stats = await fs.statfs(dir);
  const freeBytes = stats.bavail * stats.bsize;
  return { ok: freeBytes >= neededBytes + reservedBytes, freeBytes };
}
