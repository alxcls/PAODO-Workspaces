// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import { archiveSet } from "../lib/infra/backup/set";
import { pushSet } from "../lib/infra/backup/setTransfer";
import { reportArchived } from "./archiveCli";
import { SET_MANIFEST_MEMBER } from "../lib/archive/setManifest";

const USAGE = `Usage:
  npm run backup:all -- <destination-dir> [--push]`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const push = args.includes("--push");
  const dest = args.find((arg) => arg !== "--push");
  if (!dest) throw new Error(USAGE);

  const { manifest, setDir, prefix, archives } = await archiveSet(dest);

  for (const archive of archives) reportArchived(manifest.source.deployment, archive);
  if (push) {
    for (const url of await pushSet(setDir, manifest, prefix)) console.log(`Pushed to ${url}`);
  }
  console.log(`Backup set ${prefix} complete: ${archives.length} archives + ${SET_MANIFEST_MEMBER}.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
