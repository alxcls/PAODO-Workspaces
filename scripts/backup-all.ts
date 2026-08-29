// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import path from "path";
import { archiveGraph } from "../lib/infra/graph/archive";
import { archiveDatabase } from "../lib/infra/data/archive";
import { archiveWorkspace } from "../lib/infra/workspace/archive";
import { hashDockerfile } from "../lib/infra/docker/dockerfileHasher";
import { getStore } from "../lib/infra/services";
import { pushArchive } from "../lib/infra/backup/s3Sink";
import { reportArchived } from "./archiveCli";
import type { ArchiveManifest } from "../lib/archive/manifest";

const USAGE = `Usage:
  npm run backup:all -- <destination-dir> [--push]`;

interface Written {
  path: string;
  bytes: number;
  manifest: ArchiveManifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const dest = args.find((arg) => arg !== "--push");
  if (!dest) throw new Error(USAGE);

  const image = {
    ref: process.env.CONTAINER_IMAGE ?? "paodo-workspace",
    hash: await hashDockerfile("Dockerfile.workspace"),
  };
  const workspaces = getStore().listWorkspaces();

  const results: Written[] = [await archiveGraph(dest), await archiveDatabase(dest)];
  for (const workspace of workspaces) {
    results.push(await archiveWorkspace(workspace, dest, { image }));
  }

  for (const result of results) {
    reportArchived(result.manifest.source.deployment, result);
    if (push) {
      const key = `${result.manifest.source.deployment}/${path.basename(result.path)}`;
      console.log(`Pushed to ${await pushArchive(result.path, key)}`);
    }
  }
  console.log(`Backup set complete: ${results.length} archives (graph + database + ${workspaces.length} workspaces).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
