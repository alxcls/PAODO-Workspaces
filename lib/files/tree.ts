// Shared file-tree walker for the workspace and drive file-panel routes.
// Recursively walks a directory, skipping whatever the shared ignore contract excludes (./ignore.ts).
// Kept here, shared and tested once, rather than copy-pasted into each route.
//
// The depth cap is the panel's, not the filesystem's: it exists so one pathological tree cannot make
// the file panel's single JSON response unbounded, and it is now a named option rather than a literal
// buried in the recursion — a caller that must see the whole tree (a transfer manifest, where a
// silently truncated answer means a nested project diverges without anyone being told) passes
// Infinity and gets it.
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { readTransferEntries } from "./entries";
import { openFileLimiter, type Semaphore } from "./fdLimit";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

/** What the file panel renders in one response. */
export const FILE_PANEL_MAX_DEPTH = 5;

export interface BuildTreeOptions {
  /** Levels to descend before stopping. Infinity walks the whole tree. */
  maxDepth?: number;
}

export async function buildTree(dirPath: string, options: BuildTreeOptions = {}): Promise<TreeNode[]> {
  const maxDepth = options.maxDepth ?? FILE_PANEL_MAX_DEPTH;
  return walk(dirPath, 0, maxDepth, openFileLimiter());
}

async function walk(dirPath: string, depth: number, maxDepth: number, sem: Semaphore): Promise<TreeNode[]> {
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
    const fullPath = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        type: "directory",
        path: fullPath,
        children: await walk(fullPath, depth + 1, maxDepth, sem),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath });
    }
  }

  return nodes;
}
