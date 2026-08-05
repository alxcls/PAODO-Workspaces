// Shared file-tree walker for the workspace and drive file-panel routes.
// Recursively walks a directory up to 5 levels deep, skipping common build/dependency folders.
// Kept here, shared and tested once, rather than copy-pasted into each route.
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

export async function buildTree(dirPath: string, depth = 0): Promise<TreeNode[]> {
  if (depth >= 5) return [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    createLogger("api").warn({ err, dirPath }, "failed to read directory in file tree");
    return [];
  }

  const filtered = entries.filter((e) => !IGNORED.includes(e.name) && !/\.(pyc|pyo)$/.test(e.name));
  const nodes: TreeNode[] = [];
  for (const e of filtered) {
    const fullPath = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        type: "directory",
        path: fullPath,
        children: await buildTree(fullPath, depth + 1),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath });
    }
  }

  return nodes;
}
