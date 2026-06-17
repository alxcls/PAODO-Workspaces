// Host-side path-containment guard for workspace file routes. The browser can hand these routes an
// arbitrary filesystem path (a ?path= query param, URL segments); this is the chokepoint that keeps
// such a path inside the workspace dir. It resolves symlinks BEFORE checking the boundary, so a
// symlink planted inside the workspace cannot silently point at a host file outside it.
//
// This is the host-side counterpart to lib/agent/pathUtils.ts normalizeRelpath, which guards the
// container side. Keep it here, shared and tested once, rather than copy-pasted into each route.
import fs from "fs/promises";
import path from "path";

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
    throw new Error("Path is outside workspace");
  }
  return resolved;
}
