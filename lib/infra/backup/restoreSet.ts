// Applies a full backup set back onto this deployment: the inverse of archiveSet. Verifies every
// archive before writing a byte, then restores in dependency order: workspaces, database, graph.
import path from "path";
import { readFile } from "fs/promises";
import { sha256File, verifyArchive, exists, deploymentName } from "../archive/core";
import { WORKSPACES_ROOT } from "../paths";
import { createAuditLogger } from "../logger";
import { SET_MANIFEST_MEMBER, type BackupSet } from "../../archive/setManifest";
import { applyWorkspaceArchive, type WorkspaceApplied } from "../workspace/apply";
import { applyDatabaseArchive } from "../data/apply";
import { applyGraphArchive } from "../graph/apply";

const audit = createAuditLogger("restore");

export interface RestoreSetOptions {
  /** Root to restore into. Defaults to WORKSPACES_ROOT. Overridable for tests. */
  rootDir?: string;
  /** Overwrite existing live state, and permit a set from another deployment. */
  force?: boolean;
}

export interface RestoreSetResult {
  manifest: BackupSet;
  workspaces: WorkspaceApplied[];
}

// Re-hashes every archive against backup.json (set-level) and checks each against its own manifest
// (member-level), collecting all problems so the caller can abort before anything is written.
async function verifyEntries(setDir: string, manifest: BackupSet): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of manifest.entries) {
    const file = path.join(setDir, entry.file);
    if (!(await exists(file))) {
      problems.push(`${entry.file}: missing from set`);
      continue;
    }
    if ((await sha256File(file)) !== entry.sha256) problems.push(`${entry.file}: sha256 does not match backup.json`);
    const verified = await verifyArchive(file);
    for (const problem of verified.problems) problems.push(`${entry.file}: ${problem}`);
  }
  return problems;
}

export async function restoreSet(setDir: string, opts: RestoreSetOptions = {}): Promise<RestoreSetResult> {
  const root = opts.rootDir ?? WORKSPACES_ROOT;
  // Named so a failure logs where it stopped: the box may be half-restored past this point.
  let phase = "read_manifest";
  try {
    const manifest = JSON.parse(await readFile(path.join(setDir, SET_MANIFEST_MEMBER), "utf-8")) as BackupSet;

    const here = deploymentName();
    if (!opts.force && manifest.source.deployment !== here) {
      throw new Error(
        `set is from deployment "${manifest.source.deployment}", not "${here}" — pass force to restore across deployments.`,
      );
    }

    phase = "verify";
    const problems = await verifyEntries(setDir, manifest);
    if (problems.length > 0) {
      throw new Error(`set failed verification; nothing was written:\n  ${problems.join("\n  ")}`);
    }

    const workspaces: WorkspaceApplied[] = [];
    for (const entry of manifest.entries) {
      if (entry.kind !== "workspace") continue;
      phase = `workspace ${entry.workspaceId}`;
      workspaces.push(await applyWorkspaceArchive(path.join(setDir, entry.file), { rootDir: root, force: opts.force }));
    }

    const dbEntry = manifest.entries.find((entry) => entry.kind === "database");
    if (!dbEntry) throw new Error("set has no database archive");
    phase = "database";
    await applyDatabaseArchive(path.join(setDir, dbEntry.file), { rootDir: root, force: opts.force });

    const graphEntry = manifest.entries.find((entry) => entry.kind === "graph");
    if (!graphEntry) throw new Error("set has no graph archive");
    phase = "graph";
    await applyGraphArchive(path.join(setDir, graphEntry.file), { rootDir: root, force: opts.force });

    audit.info(
      { event: "set_restored", setId: manifest.id, instance: manifest.instance, workspaces: workspaces.length },
      "backup set restored",
    );
    return { manifest, workspaces };
  } catch (err) {
    const wrote = phase !== "read_manifest" && phase !== "verify";
    audit.error(
      { event: "set_restore_failed", outcome: wrote ? "set_partially_restored" : "set_not_restored", setDir, phase, err },
      "backup set restore failed",
    );
    throw err;
  }
}
