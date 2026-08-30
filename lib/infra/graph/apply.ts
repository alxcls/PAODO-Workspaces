// Restores the deployment-wide agent graph from its archive: the inverse of archiveGraph. Writes the
// whole graph file back, applied last in a set restore since its edges reference workspaces by id.
import { mkdtemp, rm, copyFile, mkdir } from "fs/promises";
import os from "os";
import path from "path";
import { extractArchive, exists } from "../archive/core";
import { createAuditLogger } from "../logger";
import { WORKSPACES_ROOT, workspaceGraphFile } from "../paths";
import { GRAPH_MEMBER } from "../../graph/archive";

const audit = createAuditLogger("restore");

export interface GraphApplyOptions {
  /** Root the graph file lives under. Defaults to WORKSPACES_ROOT. Overridable for tests. */
  rootDir?: string;
  /** Overwrite an existing graph rather than refuse. */
  force?: boolean;
}

export async function applyGraphArchive(archivePath: string, opts: GraphApplyOptions = {}): Promise<void> {
  const root = opts.rootDir ?? WORKSPACES_ROOT;
  let stageDir: string | undefined;
  try {
    stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-graph-restore-"));
    await extractArchive(archivePath, stageDir);
    await mkdir(root, { recursive: true });
    const target = workspaceGraphFile(root);
    if (!opts.force && (await exists(target))) throw new Error(`refusing to overwrite ${target} without force`);
    await copyFile(path.join(stageDir, GRAPH_MEMBER), target);
    audit.info({ event: "graph_restored", path: target }, "graph restored");
  } finally {
    if (stageDir) await rm(stageDir, { recursive: true, force: true });
  }
}
