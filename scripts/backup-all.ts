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
import {
  SET_MANIFEST_MEMBER,
  type BackupSetManifest,
  type SetMember,
} from "../lib/archive/setManifest";

const USAGE = `Usage:
  npm run backup:all -- <destination-dir> [--push]`;

interface Written {
  path: string;
  bytes: number;
  manifest: ArchiveManifest;
}

async function setMemberOf(result: Written): Promise<SetMember> {
  const workspaceId = isWorkspaceManifest(result.manifest) ? result.manifest.workspace.id : undefined;
  return {
    name: path.basename(result.path),
    bytes: result.bytes,
    sha256: await sha256File(result.path),
    kind: result.manifest.kind,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const dest = args.find((arg) => arg !== "--push");
  if (!dest) throw new Error(USAGE);

  const source = archiveSource(new Date());
  const id = `${archiveStamp(new Date(source.capturedAt))}-${randomBytes(3).toString("hex")}`;
  const prefix = `${slugify(source.deployment)}/${id}`;
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

  const manifest: BackupSetManifest = {
    schemaVersion: SCHEMA_VERSIONS.set,
    kind: "set",
    id,
    source,
    members: await Promise.all(results.map(setMemberOf)),
  };
  const manifestPath = path.join(setDir, SET_MANIFEST_MEMBER);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  for (const result of results) reportArchived(source.deployment, result);
  if (push) {
    for (const member of manifest.members) {
      console.log(`Pushed to ${await pushArchive(path.join(setDir, member.name), `${prefix}/${member.name}`)}`);
    }
    console.log(`Pushed to ${await pushArchive(manifestPath, `${prefix}/${SET_MANIFEST_MEMBER}`)}`);
  }
  console.log(`Backup set ${prefix} complete: ${results.length} archives + ${SET_MANIFEST_MEMBER}.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
