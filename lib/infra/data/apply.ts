// Restores the database and workspace registry from their archive: the inverse of archiveDatabase.
// Refuses a DB from newer code and clears the stale WAL sidecar so no old-log replay corrupts it.
import { mkdtemp, rm, copyFile, mkdir, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { extractArchive, exists } from "../archive/core";
import { createAuditLogger } from "../logger";
import { workspaceRegistryFile } from "../paths";
import { PAODO_DB_FILE, invalidateAppDataDb } from "../../data/database";
import { DATABASE_MIGRATIONS } from "../../data/migrations";
import { DATABASE_MEMBER, REGISTRY_MEMBER, type DatabaseArchiveManifest } from "../../data/archive";
import { MANIFEST_MEMBER } from "../../archive/manifest";

const audit = createAuditLogger("restore");

const DB_FILE_NAME = ".paodo.db";

export interface DatabaseApplyOptions {
  /** Root the database and registry live under. Defaults to the live PAODO_DB_FILE's dir. */
  rootDir?: string;
  /** Overwrite an existing database rather than refuse. */
  force?: boolean;
}

export async function applyDatabaseArchive(archivePath: string, opts: DatabaseApplyOptions = {}): Promise<void> {
  const root = opts.rootDir ?? path.dirname(PAODO_DB_FILE);
  let stageDir: string | undefined;
  try {
    stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-db-restore-"));
    await extractArchive(archivePath, stageDir);

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
    if (await exists(path.join(stageDir, REGISTRY_MEMBER))) {
      await copyFile(path.join(stageDir, REGISTRY_MEMBER), workspaceRegistryFile(root));
    }
    audit.info({ event: "database_restored", path: dbTarget }, "database restored");
  } finally {
    if (stageDir) await rm(stageDir, { recursive: true, force: true });
  }
}
