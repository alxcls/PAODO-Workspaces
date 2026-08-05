// Host-side path-containment guard for workspace file routes. The browser can hand these routes an
// arbitrary filesystem path (a ?path= query param, URL segments); this is the chokepoint that keeps
// such a path inside the workspace dir. It resolves symlinks BEFORE checking the boundary, so a
// symlink planted inside the workspace cannot silently point at a host file outside it.
//
// This is the host-side counterpart to lib/agent/pathUtils.ts normalizeRelpath, which guards the
// container side. Keep it here, shared and tested once, rather than copy-pasted into each route.
//
// Sibling: ./containment.ts resolveContained covers the other ergonomics — it takes a *relative*
// caller-supplied path, returns null instead of throwing, and tolerates an arbitrarily deep
// not-yet-existing tail (this module's fallback resolves only one missing level, so the target's
// parent must already exist). Reach for that one when the path comes from an upload or agent tool
// and may not exist yet; reach for this one when a route has an absolute path and wants a 4xx.
import fs from "fs/promises";
import path from "path";

/**
 * Thrown when a path resolves outside the workspace. Typed rather than a bare Error so the file
 * routes can recognise it without matching on the message: it surfaces to the user as a 4xx and is
 * deliberately not logged (see logFileRouteError), because a normal click reaches it — fileTree
 * lists symlinks as ordinary files and the boundary check below resolves them first.
 */
export class PathContainmentError extends Error {
  constructor(readonly attemptedPath: string) {
    super("Path is outside workspace");
    this.name = "PathContainmentError";
  }
}

export async function assertInsideWorkspace(wsDir: string, filePath: string): Promise<string> {
  const wsReal = await fs.realpath(wsDir);
  let resolved: string;
  try {
    resolved = await fs.realpath(filePath);
  } catch {
    // File doesn't exist yet (e.g. a write to a new path) — resolve the parent
    // directory, which must already exist, then reconstruct the full path.
    const parentReal = await fs.realpath(path.dirname(filePath));
    resolved = path.join(parentReal, path.basename(filePath));
  }
  if (!resolved.startsWith(wsReal + path.sep) && resolved !== wsReal) {
    throw new PathContainmentError(filePath);
  }
  return resolved;
}
