// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import path from "path";
import { randomBytes } from "crypto";
import { writeFile } from "fs/promises";
import { archiveGraph } from "../lib/infra/graph/archive";
import { archiveDatabase } from "../lib/infra/data/archive";
import { archiveWorkspace } from "../lib/infra/workspace/archive";
import { archiveSource, archiveStamp, sha256File, slugify } from "../lib/infra/archive/core";
import { hashDockerfile } from "../lib/infra/docker/dockerfileHasher";
import { getStore } from "../lib/infra/services";
import { pushArchive } from "../lib/infra/backup/s3Sink";
import { reportArchived } from "./archiveCli";
import { isWorkspaceManifest } from "../lib/workspace/archive";
import { SCHEMA_VERSIONS, type ArchiveManifest } from "../lib/archive/manifest";
import { SET_MANIFEST_MEMBER, type BackupSet, type SetEntry } from "../lib/archive/setManifest";

const USAGE = `Usage:
  npm run backup:all -- <destination-dir> [--push]`;

interface Written {
  path: string;
  bytes: number;
  manifest: ArchiveManifest;
}

async function setEntryOf(result: Written): Promise<SetEntry> {
  const { manifest } = result;
  const file = path.basename(result.path);
  const bytes = result.bytes;
  const sha256 = await sha256File(result.path);
  if (manifest.kind === "workspace") {
    if (!isWorkspaceManifest(manifest)) throw new Error("workspace archive missing workspace manifest");
    return { kind: "workspace", file, bytes, sha256, workspaceId: manifest.workspace.id };
  }
  return { kind: manifest.kind, file, bytes, sha256 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const dest = args.find((arg) => arg !== "--push");
  if (!dest) throw new Error(USAGE);

  const source = archiveSource(new Date());
  const id = randomBytes(6).toString("hex");
  const stamp = archiveStamp(new Date(source.capturedAt));
  const prefix = `${slugify(source.deployment)}/${stamp}-${id}`;
  const setDir = path.join(dest, prefix);

  const image = {
    ref: process.env.CONTAINER_IMAGE ?? "paodo-workspace",
    hash: await hashDockerfile("Dockerfile.workspace"),
  };
  const workspaces = getStore().listWorkspaces();

  const results: Written[] = [await archiveGraph(setDir), await archiveDatabase(setDir)];
  for (const workspace of workspaces) {
    results.push(await archiveWorkspace(workspace, setDir, { image }));
  }

  const manifest: BackupSet = {
    schemaVersion: SCHEMA_VERSIONS.set,
    kind: "set",
    id,
    source,
    entries: await Promise.all(results.map(setEntryOf)),
  };
  const manifestPath = path.join(setDir, SET_MANIFEST_MEMBER);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  for (const result of results) reportArchived(source.deployment, result);
  if (push) {
    for (const entry of manifest.entries) {
      console.log(`Pushed to ${await pushArchive(path.join(setDir, entry.file), `${prefix}/${entry.file}`)}`);
    }
    console.log(`Pushed to ${await pushArchive(manifestPath, `${prefix}/${SET_MANIFEST_MEMBER}`)}`);
  }
  console.log(`Backup set ${prefix} complete: ${results.length} archives + ${SET_MANIFEST_MEMBER}.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
