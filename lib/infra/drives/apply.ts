// Restores drives from their archive: the inverse of archiveDrives. The archive is authoritative and
// always carries all three members (empty when unset), so live state is replaced wholesale to match.
import { copyFile, mkdir } from "fs/promises";
import path from "path";
import { withExtractedArchive, extractArchive, exists, removeTree } from "../archive/core";
import { createAuditLogger } from "../logger";
import { WORKSPACES_ROOT, drivesRegistryFile, driveConnectionsFile, drivesContentDir } from "../paths";
import { CONNECTIONS_MEMBER, CONTENT_MEMBER, DRIVES_MEMBER } from "../../drives/archive";

const audit = createAuditLogger("restore");

export interface DrivesApplyOptions {
  /** Root the registry, connections and content live under. Defaults to WORKSPACES_ROOT. */
  rootDir?: string;
  /** Overwrite existing drive state rather than refuse. */
  force?: boolean;
}

export async function applyDrivesArchive(archivePath: string, opts: DrivesApplyOptions = {}): Promise<void> {
  const root = opts.rootDir ?? WORKSPACES_ROOT;
  await withExtractedArchive(archivePath, async (stageDir) => {
    const registry = drivesRegistryFile(root);
    const connections = driveConnectionsFile(root);
    const contentDir = drivesContentDir(root);

    // Multi-file store, so the guard covers all three live targets, not just the registry.
    if (!opts.force && ((await exists(registry)) || (await exists(connections)) || (await exists(contentDir)))) {
      throw new Error(`refusing to overwrite existing drive state under ${root} without force`);
    }
    await mkdir(root, { recursive: true });

    // Content, then connections, then registry last — the safe order deleteDrive uses.
    await removeTree(contentDir);
    const stagedContent = path.join(stageDir, CONTENT_MEMBER);
    if (await exists(stagedContent)) {
      await mkdir(contentDir, { recursive: true });
      await extractArchive(stagedContent, contentDir);
    }
    await copyFile(path.join(stageDir, CONNECTIONS_MEMBER), connections);
    await copyFile(path.join(stageDir, DRIVES_MEMBER), registry);

    audit.info({ event: "drives_restored", path: registry }, "drives restored");
  });
}
