// Returns a shared drive's file tree as nested JSON for the file tree panel.
// Mirrors the workspace files route but walks the drive's content directory on disk.
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getDrive, driveContentDir } from "@/lib/workspace/driveStore";
import { createLogger } from "@/lib/infra/logger";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

async function buildTree(dirPath: string, depth = 0): Promise<TreeNode[]> {
  if (depth >= 5) return [];
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    createLogger("api").warn({ err, dirPath }, "failed to read directory in drive file tree");
    return [];
  }
  const filtered = entries.filter((e) => !IGNORED.includes(e.name) && !/\.(pyc|pyo)$/.test(e.name));
  const nodes: TreeNode[] = [];
  for (const e of filtered) {
    const fullPath = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      nodes.push({ name: e.name, type: "directory", path: fullPath, children: await buildTree(fullPath, depth + 1) });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath });
    }
  }
  return nodes;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getDrive(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tree = await buildTree(driveContentDir(id));
  return NextResponse.json({ tree });
}
