// Durable on-disk weight of one workspace, for the home-panel storage line.
//
// A workspace spreads across three directories: its /workspace tree (<root>/<id>), its durable
// /home/dev (.homes/<id>), and its snapshot history (.versioning/<id>). Each is summed by walking
// its files; a directory that does not exist yet counts as 0 rather than failing the request.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { WORKSPACES_ROOT, workspaceHomeDir } from "@/lib/infra/paths";

export interface WorkspaceDiskUsage {
  workspaceId: string;
  bytes: number;
  breakdown: { workspace: number; home: number; versioning: number };
}

// Sum of regular-file sizes under `dir`. Symlinks and special files are skipped (Dirent reflects
// lstat, so isFile/isDirectory are false for them), which keeps the walk inside the tree.
async function dirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        /* raced deletion or unreadable entry — skip it */
      }
    }
  }
  return total;
}

export async function getWorkspaceDiskUsage(
  workspaceId: string,
  root: string = WORKSPACES_ROOT,
): Promise<WorkspaceDiskUsage> {
  const [workspace, home, versioning] = await Promise.all([
    dirSize(path.join(root, workspaceId)),
    dirSize(workspaceHomeDir(workspaceId, root)),
    dirSize(path.join(root, ".versioning", workspaceId)),
  ]);
  return {
    workspaceId,
    bytes: workspace + home + versioning,
    breakdown: { workspace, home, versioning },
  };
}
