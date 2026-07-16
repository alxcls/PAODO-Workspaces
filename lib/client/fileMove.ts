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

/**
 * Serializes editor saves/deletes against moves that affect the same file. Disabled buttons alone
 * are not enough: React may not commit their next state before another click/drag event arrives.
 */
export class EditorFileMutationLock {
  private activeMutationPath: string | null = null;
  private moveRoot: string | null = null;

  startMutation(path: string): boolean {
    if (
      this.activeMutationPath !== null
      || (this.moveRoot !== null && isPathWithinRoot(path, this.moveRoot))
    ) {
      return false;
    }
    this.activeMutationPath = path;
    return true;
  }

  finishMutation(): void {
    this.activeMutationPath = null;
  }

  startMove(sourceRoot: string, currentPath: string | null): boolean {
    if (this.moveRoot !== null) return false;
    if (
      this.activeMutationPath !== null
      && isPathWithinRoot(this.activeMutationPath, sourceRoot)
    ) {
      return false;
    }
    if (currentPath !== null && isPathWithinRoot(currentPath, sourceRoot)) {
      this.moveRoot = sourceRoot;
    }
    return true;
  }

  finishMove(sourceRoot: string): void {
    if (this.moveRoot === sourceRoot) this.moveRoot = null;
  }

  get pendingMoveRoot(): string | null {
    return this.moveRoot;
  }
}

/** A directory cannot be dropped onto itself or anywhere below itself. */
export function canMoveToDirectory(
  source: { path: string; type: "file" | "directory" },
  destinationDirectory: string,
): boolean {
  return source.type !== "directory"
    || !isPathWithinRoot(destinationDirectory, source.path);
}
