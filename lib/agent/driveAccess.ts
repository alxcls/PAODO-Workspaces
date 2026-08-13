// Shared helpers for the drive_* agent tools. Resolves a (drive_name, relative path) pair to an
// absolute host path inside the drive's content directory, scoped to the drives THIS workspace is
// connected to, with traversal guarded. Drives are touched host-side only — never via a container.
import path from "path";
import fs from "fs/promises";
import { normalizeRelpath } from "./pathUtils";
import { toolError } from "./toolUtils";
import { formatOutputBytes } from "@/lib/infra/limits";
import { resolveDriveDir, type Drive } from "@/lib/drives/store";

export interface ResolvedDrivePath {
  drive: Drive;
  driveDir: string;
  /** Absolute host path of the target inside the drive (equals driveDir when relPath is empty). */
  absPath: string;
  /** The normalized relative path within the drive (may be ""). */
  relPath: string;
}

// Returns a resolved path, or an "Error: ..." string suitable for returning straight from a tool.
export function resolveDrivePath(workspaceId: string, driveName: string, relPath?: string): ResolvedDrivePath | string {
  const resolved = resolveDriveDir(workspaceId, driveName);
  if (!resolved) return `Error: no drive named "${driveName}" is connected to this workspace`;

  let rel = "";
  if (relPath && relPath !== "." && relPath !== "/") {
    const norm = normalizeRelpath(relPath.replace(/^\/+/, ""));
    if (norm === null) return "Error: path is outside the drive";
    rel = norm;
  }
  return {
    drive: resolved.drive,
    driveDir: resolved.dir,
    absPath: rel ? path.join(resolved.dir, rel) : resolved.dir,
    relPath: rel,
  };
}

/**
 * Read a whole file into memory under a ceiling, refusing rather than truncating.
 *
 * Every other ceiling in the app bounds output flowing THROUGH a container or a subprocess. The drive
 * tools are the exception by design — "drives are touched host-side only" (top of this file) — so
 * `fs.readFile` here is a direct, unbounded path into the app's heap that no container limit and no
 * capture ceiling sits above. A multi-gigabyte file on a shared drive was enough to take the whole
 * instance down through an ordinary tool call. This is the bound for that.
 *
 * It refuses instead of truncating because both callers of the transfer ceiling copy bytes: half a
 * SQLite database written to a destination is corruption that reports success, which is worse than
 * an error. drive_read refuses for a different reason — it has no offset/limit to resume from, so a
 * truncated read would be a dead end, and drive_download + file_read is the real way through.
 *
 * Mechanically it stats first, then reads through a handle bounded at `limit + 1`. The stat is what
 * makes the refusal specific ("the file is 312.4MB"); the bounded read is what makes the guarantee
 * hold anyway if the file grows between the two — a live shared drive is exactly where that happens.
 *
 * Returns the bytes, or an `Error: ...` string ready to return straight from a tool (the same
 * convention as resolveDrivePath above). `advice` is appended to the too-large refusal: the size and
 * the ceiling are phrased identically everywhere, and only the way forward differs per tool.
 */
export async function readFileBounded(
  absPath: string,
  limit: number,
  labels: { missing: string; isDirectory: string; advice: string },
): Promise<Buffer | string> {
  let handle;
  try {
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) return labels.isDirectory;
    if (stat.size > limit) {
      return (
        `Error: file is ${formatOutputBytes(stat.size)}, over the ${formatOutputBytes(limit)} limit for this tool. ` +
        labels.advice
      );
    }

    handle = await fs.open(absPath, "r");
    // One byte more than the stat said, so that a file which grew in between reads as "changed"
    // rather than coming back silently short of itself. Sizing to the stat rather than to the limit
    // is what keeps a 2KB read from allocating the whole 50MB ceiling.
    const expected = Math.min(stat.size, limit);
    const buf = Buffer.alloc(expected + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > expected) {
      // Someone is writing this file right now. Whatever we hold is a torn read — half of one
      // version and half of another — and copying that into a drive or a workspace would report
      // success over a corrupt file, the one outcome this helper exists to prevent.
      return `Error: "${path.basename(absPath)}" changed while being read — it is being written to. Try again once the write has finished.`;
    }
    return buf.subarray(0, bytesRead);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return labels.missing;
    if (e.code === "EISDIR") return labels.isDirectory;
    return toolError(e);
  } finally {
    await handle?.close();
  }
}
