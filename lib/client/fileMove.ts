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

/**
 * Reduce paths to the ones that must be acted on directly, dropping any that already travel with a
 * selected ancestor — a checked folder carries its contents, so moving or deleting both the folder
 * and its children would act on the children twice, at paths that no longer exist.
 */
export function collapseToRoots(paths: string[]): string[] {
  return paths.filter(
    (p) => !paths.some((other) => other !== p && isPathWithinRoot(p, other)),
  );
}

/** A multi-item drop is all-or-nothing: one source that rejects the destination refuses the drop. */
export function canMoveAllToDirectory(
  sources: { path: string; type: "file" | "directory" }[],
  destinationDirectory: string,
): boolean {
  return sources.length > 0
    && sources.every((source) => canMoveToDirectory(source, destinationDirectory));
}
