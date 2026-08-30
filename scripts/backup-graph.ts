// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import { archiveGraph } from "../lib/infra/graph/archive";
import { reportArchived, verifyAndReport } from "./archiveCli";

const USAGE = `Usage:
  npm run backup:graph -- <destination-dir-or-file>
  npm run backup:graph -- --verify <archive.tar>`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--verify") {
    if (!args[1]) throw new Error(USAGE);
    await verifyAndReport(args[1]);
    return;
  }

  const destination = args[0];
  if (!destination) throw new Error(USAGE);

  const result = await archiveGraph(destination);
  reportArchived(result.manifest.source.deployment, result);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
