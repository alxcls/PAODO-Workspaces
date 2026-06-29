// Returns the workspace file tree as a nested JSON structure for the file tree panel.
// Recursively walks the workspace directory up to 5 levels deep, skipping common build/dependency folders.
import { NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
import { loadPermissions } from "@/lib/infra/docker/agentPermissionStore";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  /** Absolute host path (used as the React key / selection id). */
  path: string;
  /** Workspace-relative path — the key used by the agent-permissions store and its API. */
  relPath: string;
  /** Agent file-restriction flags, projected from the permission store for the badge UI. These are
   *  EFFECTIVE (true when keyed on this node OR inherited from an ancestor folder — restrictions
   *  trickle down the subtree). The `*Inherited` flags mark the inherited-only case so the UI can
   *  render it as a dimmed, read-only badge (the real toggle lives on the folder that set it). */
  denyRead?: boolean;
  denyEdit?: boolean;
  privileged?: boolean;
  denyReadInherited?: boolean;
  denyEditInherited?: boolean;
  privilegedInherited?: boolean;
  children?: TreeNode[];
}

/** Effective restriction state carried down the tree from ancestor folders. */
interface InheritedPerms {
  denyRead: boolean;
  denyEdit: boolean;
  privileged: boolean;
}
const NO_INHERIT: InheritedPerms = { denyRead: false, denyEdit: false, privileged: false };

const IGNORED = [".git", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache"];

// Membership sets for the three permission lists, so each node can be annotated in O(1).
interface PermSets {
  denyRead: Set<string>;
  denyEdit: Set<string>;
  privileged: Set<string>;
}

async function buildTree(
  rootDir: string,
  dirPath: string,
  perms: PermSets,
  inherited: InheritedPerms = NO_INHERIT,
  depth = 0,
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
    const relPath = path.relative(rootDir, fullPath);

    // Effective = keyed directly on this node OR inherited from an ancestor folder.
    const eff: InheritedPerms = {
      denyRead: inherited.denyRead || perms.denyRead.has(relPath),
      denyEdit: inherited.denyEdit || perms.denyEdit.has(relPath),
      privileged: inherited.privileged || perms.privileged.has(relPath),
    };
    const flags = {
      denyRead: eff.denyRead || undefined,
      denyEdit: eff.denyEdit || undefined,
      privileged: eff.privileged || undefined,
      denyReadInherited: (eff.denyRead && !perms.denyRead.has(relPath)) || undefined,
      denyEditInherited: (eff.denyEdit && !perms.denyEdit.has(relPath)) || undefined,
      privilegedInherited: (eff.privileged && !perms.privileged.has(relPath)) || undefined,
    };
    if (e.isDirectory()) {
      nodes.push({
        name: e.name, type: "directory", path: fullPath, relPath, ...flags,
        children: await buildTree(rootDir, fullPath, perms, eff, depth + 1),
      });
    } else {
      nodes.push({ name: e.name, type: "file", path: fullPath, relPath, ...flags });
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
  // A corrupt store shouldn't blank the file tree — fall back to no annotations.
  let p;
  try {
    p = loadPermissions(id);
  } catch {
    p = { denyRead: [], denyEdit: [], privilegedScripts: [] };
  }
  const perms: PermSets = {
    denyRead: new Set(p.denyRead),
    denyEdit: new Set(p.denyEdit),
    privileged: new Set(p.privilegedScripts),
  };
  const tree = await buildTree(ws.dir, ws.dir, perms);
  return NextResponse.json({ tree });
}
