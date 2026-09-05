// Captures the shared-drive registry, its connections and every drive's content as one verifiable
// archive. Every member is always written (empty when unset) so a restore makes live state match it.
import { mkdtemp, copyFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  archiveSource,
  archiveStamp,
  describeMembers,
  exists,
  resolveDestination,
  run,
  slugify,
  writeArchive,
} from "../archive/core";
import { createAuditLogger, createLogger } from "../logger";
import { drivesRegistryFile, driveConnectionsFile, drivesContentDir } from "../paths";
import { SCHEMA_VERSIONS, MANIFEST_MEMBER } from "../../archive/manifest";
import {
  CONNECTIONS_MEMBER,
  CONTENT_MEMBER,
  DRIVES_MEMBER,
  DRIVES_MEMBER_ORDER,
  type DrivesArchiveManifest,
} from "../../drives/archive";

const log = createLogger("archive");
const audit = createAuditLogger("archive");

const ARCHIVE_SUFFIX = ".tar.gz";

export interface DrivesArchiveResult {
  path: string;
  bytes: number;
  manifest: DrivesArchiveManifest;
}

export interface DrivesArchiveOptions {
  /** Root holding the drive registry, connections and content. Overridable for tests. */
  rootDir?: string;
}

export function drivesArchiveFileName(deployment: string, at: Date): string {
  return `paodo-drives-${slugify(deployment)}-${archiveStamp(at)}${ARCHIVE_SUFFIX}`;
}

/** Registry and connections are always captured; an unset one is an empty list, not an absent member. */
async function copyOrEmptyList(source: string, out: string): Promise<void> {
  if (await exists(source)) await copyFile(source, out);
  else await writeFile(out, "[]");
}

/**
 * Tars the drive content tree whole, always producing a member — an instance with no drives yields an
 * empty tar. Exit 1 is tar's "file changed as we read it" warning, expected on live content.
 */
async function writeContentArchive(contentDir: string, out: string, stageDir: string): Promise<void> {
  const src = (await exists(contentDir)) ? contentDir : await mkdtemp(path.join(stageDir, "empty-"));
  const result = await run("tar", ["-czf", out, "-C", src, "."]);
  if (result.code > 1) throw new Error(`tar of drive content failed: ${result.stderr || result.stdout}`);
  if (result.code === 1) log.warn({ event: "archive_drives_changed_during_read", contentDir }, result.stderr);
}

/** Writes a gzipped archive of the drive registry, connections and content. */
export async function archiveDrives(dest: string, opts: DrivesArchiveOptions = {}): Promise<DrivesArchiveResult> {
  const root = opts.rootDir;
  const capturedAt = new Date();
  const source = archiveSource(capturedAt);
  let stageDir: string | undefined;

  try {
    const target = await resolveDestination(dest, ARCHIVE_SUFFIX, () =>
      drivesArchiveFileName(source.deployment, capturedAt),
    );
    stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-drives-archive-"));
    const members = [DRIVES_MEMBER, CONNECTIONS_MEMBER, CONTENT_MEMBER];

    await copyOrEmptyList(drivesRegistryFile(root), path.join(stageDir, DRIVES_MEMBER));
    await copyOrEmptyList(driveConnectionsFile(root), path.join(stageDir, CONNECTIONS_MEMBER));
    await writeContentArchive(drivesContentDir(root), path.join(stageDir, CONTENT_MEMBER), stageDir);

    const manifest: DrivesArchiveManifest = {
      schemaVersion: SCHEMA_VERSIONS.drives,
      kind: "drives",
      source,
      contents: await describeMembers(stageDir, members),
    };
    await writeFile(path.join(stageDir, MANIFEST_MEMBER), JSON.stringify(manifest, null, 2));

    const bytes = await writeArchive(stageDir, [...DRIVES_MEMBER_ORDER], target, { gzip: true });

    audit.info(
      { event: "drives_archived", deployment: source.deployment, path: target, bytes, members: [...DRIVES_MEMBER_ORDER] },
      "drives archived",
    );
    return { path: target, bytes, manifest };
  } catch (err) {
    audit.error(
      { event: "drives_archive_failed", outcome: "drives_not_archived", err, deployment: source.deployment },
      "drives archive failed",
    );
    throw err;
  } finally {
    if (stageDir) await rm(stageDir, { recursive: true, force: true });
  }
}
