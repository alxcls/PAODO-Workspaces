// Returns the workspace file tree as a nested JSON structure for the file tree panel.
// Recursively walks the workspace directory up to 5 levels deep, skipping common build/dependency folders.
import { NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { getPermissions, type WorkspacePermissions } from "@/lib/infra/permissionStore";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
  // Permission state, so the tree can render the lock/eye/key badges. Absent = unprotected.
  locked?: boolean;
  hidden?: boolean;
  privileged?: boolean;
}

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

async function buildTree(
  rootDir: string,
  perms: WorkspacePermissions,
  dirPath: string,
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
    const rel = path.relative(rootDir, fullPath);
    const state = {
      locked: perms.locked.includes(rel) || undefined,
      hidden: perms.hidden.includes(rel) || undefined,
      privileged: perms.privileged.includes(rel) || undefined,
    };
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        type: "directory",
        path: fullPath,
        ...state,
        children: await buildTree(rootDir, perms, fullPath, depth + 1),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath, ...state });
    }
  }

  return nodes;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tree = await buildTree(ws.dir, getPermissions(id), ws.dir);
  return NextResponse.json({ tree });
}
