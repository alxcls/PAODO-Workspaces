/** Remap a path when `sourceRoot` itself, or one of its descendants, has been moved. */
export function remapMovedPath(
  currentPath: string | null,
  sourceRoot: string,
  destinationRoot: string,
): string | null {
  if (currentPath === null) return null;
  if (currentPath === sourceRoot) return destinationRoot;
  if (currentPath.startsWith(sourceRoot + "/")) {
    return destinationRoot + currentPath.slice(sourceRoot.length);
  }
  return currentPath;
}

/** Whether `path` is the root itself or one of its descendants. */
export function isPathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/** A directory cannot be dropped onto itself or anywhere below itself. */
export function canMoveToDirectory(
  source: { path: string; type: "file" | "directory" },
  destinationDirectory: string,
): boolean {
  return source.type !== "directory"
    || !isPathWithinRoot(destinationDirectory, source.path);
}
