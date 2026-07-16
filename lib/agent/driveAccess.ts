// Shared helpers for the drive_* agent tools. Resolves a (drive_name, relative path) pair to an
// absolute host path inside the drive's content directory, scoped to the drives THIS workspace is
// connected to, with traversal guarded. Drives are touched host-side only — never via a container.
import path from "path";
import { normalizeRelpath } from "./pathUtils";
import { resolveDriveDir, type Drive } from "../workspace/driveStore";

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
