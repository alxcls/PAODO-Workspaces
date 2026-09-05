// Applies a full backup set back onto this deployment: the inverse of archiveSet. Verifies every
// archive first, restores in dependency order (workspaces, database, drives, graph), then prunes any
// workspace the set omits so the box ends up as the snapshot, not merged with what was there.
import path from "path";
import { readFile } from "fs/promises";
import { sha256File, verifyArchive, exists, deploymentName, removeTree } from "../archive/core";
import { WORKSPACES_ROOT, workspaceRegistryFile, workspaceArtifactPaths } from "../paths";
import { createAuditLogger } from "../logger";
import { SET_MANIFEST_MEMBER, type BackupSet } from "../../archive/setManifest";
import { applyWorkspaceArchive, type WorkspaceApplied } from "../workspace/apply";
import { applyDatabaseArchive } from "../data/apply";
import { applyDrivesArchive } from "../drives/apply";
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
  /** Workspaces that existed live but not in the set, removed so the box matches the snapshot. */
  pruned: string[];
}

// The live workspace ids before restore, read from the registry the database archive will overwrite.
async function liveWorkspaceIds(root: string): Promise<string[]> {
  const file = workspaceRegistryFile(root);
  if (!(await exists(file))) return [];
  try {
    const rows = JSON.parse(await readFile(file, "utf-8")) as Array<{ id?: unknown }>;
    return rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

// Restoring is restoring a prior state: a workspace absent from the set must not survive it. Removes
// the same on-disk footprint applyWorkspaceArchive rebuilds, keyed by the ids the set does not hold.
async function pruneWorkspaces(root: string, liveIds: string[], keep: Set<string>): Promise<string[]> {
  const pruned: string[] = [];
  for (const id of liveIds) {
    if (keep.has(id)) continue;
    for (const target of workspaceArtifactPaths(id, root)) await removeTree(target);
    pruned.push(id);
  }
  return pruned;
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

    // Captured before the database archive overwrites the registry, to know which live ids to prune.
    const liveIds = await liveWorkspaceIds(root);
    const keep = new Set<string>();
    const workspaces: WorkspaceApplied[] = [];
    for (const entry of manifest.entries) {
      if (entry.kind !== "workspace") continue;
      keep.add(entry.workspaceId);
      phase = `workspace ${entry.workspaceId}`;
      workspaces.push(await applyWorkspaceArchive(path.join(setDir, entry.file), { rootDir: root, force: opts.force }));
    }

    const dbEntry = manifest.entries.find((entry) => entry.kind === "database");
    if (!dbEntry) throw new Error("set has no database archive");
    phase = "database";
    await applyDatabaseArchive(path.join(setDir, dbEntry.file), { rootDir: root, force: opts.force });

    // Optional: sets captured before drives were a component have no entry, and restore skips it.
    const drivesEntry = manifest.entries.find((entry) => entry.kind === "drives");
    if (drivesEntry) {
      phase = "drives";
      await applyDrivesArchive(path.join(setDir, drivesEntry.file), { rootDir: root, force: opts.force });
    }

    const graphEntry = manifest.entries.find((entry) => entry.kind === "graph");
    if (!graphEntry) throw new Error("set has no graph archive");
    phase = "graph";
    await applyGraphArchive(path.join(setDir, graphEntry.file), { rootDir: root, force: opts.force });

    // Pruning deletes live workspaces the set omits, so it is a force-only act: a non-force restore
    // onto a populated box already aborts above, but gate it here so the safety is stated, not implied.
    phase = "prune";
    const pruned = opts.force ? await pruneWorkspaces(root, liveIds, keep) : [];

    audit.info(
      {
        event: "set_restored",
        setId: manifest.id,
        instance: manifest.instance,
        workspaces: workspaces.length,
        pruned: pruned.length,
      },
      "backup set restored",
    );
    return { manifest, workspaces, pruned };
  } catch (err) {
    const wrote = phase !== "read_manifest" && phase !== "verify";
    audit.error(
      { event: "set_restore_failed", outcome: wrote ? "set_partially_restored" : "set_not_restored", setDir, phase, err },
      "backup set restore failed",
    );
    throw err;
  }
}
