// Returns the workspace file tree as a nested JSON structure for the file tree panel.
// Recursively walks the workspace directory up to 5 levels deep, skipping common build/dependency folders.
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { isAgentLocked } from "@/lib/infra/permissionStore";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  permission?: "R" | "RW";
  children?: TreeNode[];
}

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

async function buildTree(
  dirPath: string,
  workspaceDir: string,
  workspaceId: string,
  depth = 0
): Promise<TreeNode[]> {
  if (depth >= 5) return [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    createLogger("api").warn({ err, dirPath, workspaceId }, "failed to read directory in file tree");
    return [];
  }

  const nodes = await Promise.all(
    entries
      .filter((e) => !IGNORED.includes(e.name) && !/\.(pyc|pyo)$/.test(e.name))
      .map(async (e): Promise<TreeNode> => {
        const fullPath = path.join(dirPath, e.name);
        const locked = await isAgentLocked(workspaceId, workspaceDir, fullPath);
        const permission: "R" | "RW" = locked ? "R" : "RW";
        if (e.isDirectory()) {
          return {
            name: e.name,
            type: "directory",
            path: fullPath,
            permission,
            children: await buildTree(fullPath, workspaceDir, workspaceId, depth + 1),
          };
        }
        return { name: e.name, type: "file", path: fullPath, permission };
      })
  );

  return nodes;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tree = await buildTree(ws.dir, ws.dir, ws.id);
  return NextResponse.json(tree);
}
