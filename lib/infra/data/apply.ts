// Restores the database and workspace registry from their archive: the inverse of archiveDatabase.
// Refuses a DB from newer code and clears the stale WAL sidecar so no old-log replay corrupts it.
import { rm, copyFile, mkdir, readFile } from "fs/promises";
import path from "path";
import { withExtractedArchive, exists } from "../archive/core";
import { createAuditLogger } from "../logger";
import { workspaceRegistryFile } from "../paths";
import { PAODO_DB_FILE, invalidateAppDataDb } from "../../data/database";
import { DATABASE_MIGRATIONS } from "../../data/migrations";
import { DATABASE_MEMBER, REGISTRY_MEMBER, type DatabaseArchiveManifest } from "../../data/archive";
import { MANIFEST_MEMBER } from "../../archive/manifest";

const audit = createAuditLogger("restore");

const DB_FILE_NAME = path.basename(PAODO_DB_FILE);

export interface DatabaseApplyOptions {
  /** Root the database and registry live under. Defaults to the live PAODO_DB_FILE's dir. */
  rootDir?: string;
  /** Overwrite an existing database rather than refuse. */
  force?: boolean;
}

export async function applyDatabaseArchive(archivePath: string, opts: DatabaseApplyOptions = {}): Promise<void> {
  const root = opts.rootDir ?? path.dirname(PAODO_DB_FILE);
  await withExtractedArchive(archivePath, async (stageDir) => {
    const manifest = JSON.parse(
      await readFile(path.join(stageDir, MANIFEST_MEMBER), "utf-8"),
    ) as DatabaseArchiveManifest;
    const latest = DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
    if (manifest.database.userVersion > latest) {
      throw new Error(
        `database archive is version ${manifest.database.userVersion}, newer than this build supports (${latest}).`,
      );
    }

    const dbTarget = path.join(root, DB_FILE_NAME);
    if (!opts.force && (await exists(dbTarget))) {
      throw new Error(`refusing to overwrite ${dbTarget} without force`);
    }

    invalidateAppDataDb();
    await mkdir(root, { recursive: true });
    for (const sidecar of [`${dbTarget}-wal`, `${dbTarget}-shm`]) await rm(sidecar, { force: true });
    await copyFile(path.join(stageDir, DATABASE_MEMBER), dbTarget);
    // Authoritative like the db itself: a set captured with no registry clears the live one.
    const stagedRegistry = path.join(stageDir, REGISTRY_MEMBER);
    if (await exists(stagedRegistry)) await copyFile(stagedRegistry, workspaceRegistryFile(root));
    else await rm(workspaceRegistryFile(root), { force: true });
    audit.info({ event: "database_restored", path: dbTarget }, "database restored");
  });
}
