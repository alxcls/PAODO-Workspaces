// Shared file-tree walker for the workspace and drive file-panel routes.
// Recursively walks a directory, skipping whatever the shared ignore contract excludes (./ignore.ts).
// Kept here, shared and tested once, rather than copy-pasted into each route.
//
// The depth cap is the panel's, not the filesystem's: it exists so one pathological tree cannot make
// the file panel's single JSON response unbounded, and it is a named option rather than a literal
// buried in the recursion — a caller that must see the whole tree passes Infinity and gets it. That
// caller is the CLI listing (`?depth=full` on the tree route): a truncation is survivable when it
// feeds a panel someone is scrolling, and not when it feeds a client that will act on the result.
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { readTransferEntries } from "./entries";
import { openFileLimiter, type Semaphore } from "./fdLimit";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  /**
   * Workspace-relative, POSIX-separated — the one path space the file API speaks (./relpath.ts).
   * It used to be the absolute host path, which made the server's directory layout part of the wire
   * contract and left a non-browser client no way to name a file at all.
   */
  path: string;
  children?: TreeNode[];
}

/** What the file panel renders in one response. */
export const FILE_PANEL_MAX_DEPTH = 5;

export interface BuildTreeOptions {
  /** Levels to descend before stopping. Infinity walks the whole tree. */
  maxDepth?: number;
}

export async function buildTree(rootDir: string, options: BuildTreeOptions = {}): Promise<TreeNode[]> {
  const maxDepth = options.maxDepth ?? FILE_PANEL_MAX_DEPTH;
  return walk(rootDir, "", 0, maxDepth, openFileLimiter());
}

/**
 * `relPath` is carried down the recursion rather than derived per node with path.relative: the walker
 * already knows where it is, and building the wire path from the segments it descended through is both
 * cheaper and impossible to get subtly wrong on a root that is itself a symlink.
 */
async function walk(
  dirPath: string,
  relPath: string,
  depth: number,
  maxDepth: number,
  sem: Semaphore,
): Promise<TreeNode[]> {
  if (depth >= maxDepth) return [];
  let entries;
  try {
    entries = await readTransferEntries(dirPath, sem);
  } catch (err) {
    // An unreadable directory renders as an empty branch rather than failing the panel: the tree is
    // navigation, and one bad directory should not blank the whole file list.
    createLogger("api").warn({ err, dirPath }, "failed to read directory in file tree");
    return [];
  }

  const nodes: TreeNode[] = [];
  for (const e of entries) {
    const hostPath = path.join(dirPath, e.name);
    const entryRelPath = relPath === "" ? e.name : `${relPath}/${e.name}`;
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        type: "directory",
        path: entryRelPath,
        children: await walk(hostPath, entryRelPath, depth + 1, maxDepth, sem),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: entryRelPath });
    }
  }

  return nodes;
}
