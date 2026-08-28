// Captures the application database and the workspace registry as one verifiable archive. Holds no
// credentials by design: the vaults live in their own volumes, and `.credentials.json` sits beside
// these files in the data root but is deliberately never a member.
import { mkdtemp, copyFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  archiveSource,
  archiveStamp,
  describeMembers,
  exists,
  resolveDestination,
  slugify,
  writeArchive,
} from "../archive/core";
import { createAuditLogger } from "../logger";
import { workspaceRegistryFile } from "../paths";
import { ARCHIVE_SCHEMA_VERSIONS, MANIFEST_MEMBER } from "../../archive/manifest";
import {
  DATABASE_MEMBER,
  DATABASE_MEMBER_ORDER,
  REGISTRY_MEMBER,
  type DatabaseArchiveManifest,
} from "../../data/archive";
import { appDataDb, backupAppDataDb } from "../../data/database";

const audit = createAuditLogger("archive");

const ARCHIVE_SUFFIX = ".tar.gz";

export interface DatabaseArchiveResult {
  path: string;
  bytes: number;
  manifest: DatabaseArchiveManifest;
}

export function databaseArchiveFileName(deployment: string, at: Date): string {
  return `paodo-db-${slugify(deployment)}-${archiveStamp(at)}${ARCHIVE_SUFFIX}`;
}

/**
 * Writes a gzipped archive of the database and registry. The database is copied through SQLite's own
 * backup call rather than the filesystem: almost all of a live database sits in the write-ahead log,
 * so a plain file copy yields something that opens cleanly and is nearly empty.
 */
export async function archiveDatabase(dest: string): Promise<DatabaseArchiveResult> {
  const capturedAt = new Date();
  const source = archiveSource(capturedAt);
  const target = await resolveDestination(dest, ARCHIVE_SUFFIX, () =>
    databaseArchiveFileName(source.deployment, capturedAt),
  );
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-db-archive-"));

  try {
    const present: string[] = [DATABASE_MEMBER];
    await backupAppDataDb(path.join(stageDir, DATABASE_MEMBER));
    const userVersion = appDataDb().pragma("user_version", { simple: true }) as number;

    const registry = workspaceRegistryFile();
    if (await exists(registry)) {
      await copyFile(registry, path.join(stageDir, REGISTRY_MEMBER));
      present.push(REGISTRY_MEMBER);
    }

    const manifest: DatabaseArchiveManifest = {
      schemaVersion: ARCHIVE_SCHEMA_VERSIONS.database,
      kind: "database",
      source,
      database: { userVersion },
      contents: await describeMembers(stageDir, present),
    };
    await writeFile(path.join(stageDir, MANIFEST_MEMBER), JSON.stringify(manifest, null, 2));

    const ordered = DATABASE_MEMBER_ORDER.filter((name) => name === MANIFEST_MEMBER || present.includes(name));
    const bytes = await writeArchive(stageDir, [...ordered], target, { gzip: true });

    audit.info(
      { event: "database_archived", deployment: source.deployment, path: target, bytes, members: ordered },
      "database archived",
    );
    return { path: target, bytes, manifest };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
