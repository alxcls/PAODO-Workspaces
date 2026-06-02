// Returns the workspace file tree as a nested JSON structure for the file tree panel.
// Recursively walks the workspace directory up to 5 levels deep, skipping common build/dependency folders.
import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { readPermissionSnapshot } from "@/lib/infra/permissionStore";
import { listSecured } from "@/lib/infra/securedScriptStore";
import { listHidden } from "@/lib/infra/hiddenStore";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  permission?: "R" | "RW";
  secured?: boolean;
  hidden?: boolean;
  children?: TreeNode[];
}

// A path is covered if it's directly listed or lives under a listed directory (prefix match),
// mirroring securedScriptStore.isSecured / hiddenStore.isHidden so tree badges match the agent tags.
function isCoveredRel(rel: string, entries: string[]): boolean {
  return entries.some((c) => c === rel || rel.startsWith(c + path.sep));
}

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

async function buildTree(
  dirPath: string,
  workspaceDir: string,
  permSnapshot: { globalLock: boolean; locked: string[] },
  secured: string[],
  hidden: string[],
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
    const isSecuredNode = isCoveredRel(rel, secured);
    const isHiddenNode = isCoveredRel(rel, hidden);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        type: "directory",
        path: fullPath,
        permission,
        secured: isSecuredNode,
        hidden: isHiddenNode,
        children: await buildTree(fullPath, workspaceDir, permSnapshot, secured, hidden, depth + 1),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath, permission, secured: isSecuredNode, hidden: isHiddenNode });
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
  const secured = listSecured(ws.id);
  const hidden = listHidden(ws.id);
  const tree = await buildTree(ws.dir, ws.dir, permSnapshot, secured, hidden);
  return NextResponse.json({ tree, globalLock: permSnapshot.globalLock });
}
