// Shared containment guard for any code that resolves a caller-supplied relative path against a
// workspace/drive root — the HTTP upload route, and (via lib/agent/pathUtils.ts) the agent's own
// file tools.
//
// A lexical-only check (normalize + reject "..") cannot see that a directory somewhere inside the
// root is actually a symlink to somewhere else on disk — e.g. `ln -s /etc workspace/escape` followed
// by a request for "escape/passwd" normalizes to a path lexically under the root, but the OS would
// actually write to /etc/passwd. Guarding against that means realpath'ing not just the root but the
// nearest EXISTING ancestor of the target and rejoining the not-yet-created remainder onto it, since
// most targets here (a new upload, an agent-created file) don't exist yet.
import fs from "fs/promises";
import path from "path";

/**
 * Resolve `requestedPath` against `rootDir`, returning the resolved real path, or `null` if it would
 * escape `rootDir` — via `..`, an absolute path, or a symlink anywhere along the way (including
 * `rootDir` itself). `rootDir` must already exist; `requestedPath` need not.
 */
export async function resolveContained(rootDir: string, requestedPath: string): Promise<string | null> {
  const root = await fs.realpath(rootDir);
  const target = path.normalize(path.resolve(root, requestedPath));
  if (target !== root && !target.startsWith(root + path.sep)) return null; // lexical escape

  // Walk up from the target until we hit something that actually exists, realpath'ing it (this is
  // what resolves an interior symlink), then reattach whatever tail didn't exist yet.
  const tail: string[] = [];
  let existing = target;
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) return null; // reached the filesystem root without finding `root`
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const real = tail.length > 0 ? path.join(existing, ...tail) : existing;
  return real === root || real.startsWith(root + path.sep) ? real : null;
}
