// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import { archiveWorkspace } from "../lib/infra/workspace/archive";
import { hashDockerfile } from "../lib/infra/docker/dockerfileHasher";
import { getStore } from "../lib/infra/services";
import { maybePushArchive, reportArchived, verifyAndReport } from "./archiveCli";

const USAGE = `Usage:
  npm run backup:workspace -- <workspace-id|name> <destination-dir-or-file> [--push]
  npm run backup:workspace -- --verify <archive.tar>`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--verify") {
    if (!args[1]) throw new Error(USAGE);
    await verifyAndReport(args[1]);
    return;
  }

  const [selector, destination] = args.filter((arg) => arg !== "--push");
  if (!selector || !destination) throw new Error(USAGE);

  const store = getStore();
  const workspace = store.getWorkspace(selector) ?? store.getWorkspaceByName(selector);
  if (!workspace) throw new Error(`No workspace matches "${selector}".`);

  const ref = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
  const result = await archiveWorkspace(workspace, destination, {
    image: { ref, hash: await hashDockerfile("Dockerfile.workspace") },
  });
  reportArchived(workspace.name, result);
  await maybePushArchive(result, args);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
