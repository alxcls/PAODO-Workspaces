// Returns the workspace file tree as a nested JSON structure for the file tree panel.
// Recursively walks the workspace directory up to 5 levels deep, skipping common build/dependency folders.
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { readPermissionSnapshot } from "@/lib/infra/permissionStore";
import { listCrowned } from "@/lib/infra/crownedScriptStore";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  permission?: "R" | "RW";
  crowned?: boolean;
  children?: TreeNode[];
}

// A path is crowned if it's directly crowned or lives under a crowned directory (prefix match),
// mirroring crownedScriptStore.isCrowned so the tree badge matches what run_crowned_script accepts.
function isCrownedRel(rel: string, crowned: string[]): boolean {
  return crowned.some((c) => c === rel || rel.startsWith(c + path.sep));
}

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

async function buildTree(
  dirPath: string,
  workspaceDir: string,
  permSnapshot: { globalLock: boolean; locked: string[] },
  crowned: string[],
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
    const rel = path.relative(workspaceDir, fullPath);
    let locked = permSnapshot.globalLock;
    if (!locked) {
      const parts = rel.split(path.sep);
      for (let i = 1; i <= parts.length; i++) {
        if (permSnapshot.locked.includes(parts.slice(0, i).join(path.sep))) { locked = true; break; }
      }
    }
    const permission: "R" | "RW" = locked ? "R" : "RW";
    const isCrowned = isCrownedRel(rel, crowned);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        type: "directory",
        path: fullPath,
        permission,
        crowned: isCrowned,
        children: await buildTree(fullPath, workspaceDir, permSnapshot, crowned, depth + 1),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath, permission, crowned: isCrowned });
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
  const crowned = listCrowned(ws.id);
  const tree = await buildTree(ws.dir, ws.dir, permSnapshot, crowned);
  return NextResponse.json({ tree, globalLock: permSnapshot.globalLock });
}
