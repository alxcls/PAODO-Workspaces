// Returns the workspace file tree as a nested JSON structure for the file tree panel.
// Recursively walks the workspace directory up to 5 levels deep, skipping common build/dependency folders.
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import {
  readPermissionSnapshot,
  isLockedFromSnapshot,
  isHiddenFromSnapshot,
  isKeyedFromSnapshot,
} from "@/lib/infra/permissionStore";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  permission?: "R" | "RW";
  hidden?: boolean;
  privileged?: boolean;
  children?: TreeNode[];
}

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

async function buildTree(
  dirPath: string,
  workspaceDir: string,
  permSnapshot: Awaited<ReturnType<typeof readPermissionSnapshot>>,
  depth = 0
): Promise<TreeNode[]> {
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
    // Use forward slashes for snapshot lookups (permissionStore normalises to /)
    const rel = path.relative(workspaceDir, fullPath).split(path.sep).join("/");
    const permission: "R" | "RW" = isLockedFromSnapshot(permSnapshot, rel) ? "R" : "RW";
    const hidden = isHiddenFromSnapshot(permSnapshot, rel);
    const privileged = isKeyedFromSnapshot(permSnapshot, rel);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        type: "directory",
        path: fullPath,
        permission,
        hidden,
        privileged,
        children: await buildTree(fullPath, workspaceDir, permSnapshot, depth + 1),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath, permission, hidden, privileged });
    }
  }

  return nodes;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  const permSnapshot = await readPermissionSnapshot(ws.id);
  const tree = await buildTree(ws.dir, ws.dir, permSnapshot);
  return NextResponse.json({ tree, globalLock: permSnapshot.globalLock });
}
