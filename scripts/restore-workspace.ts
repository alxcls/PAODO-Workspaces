// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import { applyWorkspaceArchive } from "../lib/infra/workspace/apply";

const USAGE = `Usage:
  npm run restore:workspace -- <archive.tar> [--force]

Restores a single workspace from its archive onto this deployment, rebuilding its work-tree,
versioning repo and home. Overwriting an existing workspace requires --force. The db registry is
left untouched: the workspace record must already exist, or be imported separately.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const archive = args.find((arg) => !arg.startsWith("--"));
  if (!archive) throw new Error(USAGE);

  const { id, name } = await applyWorkspaceArchive(archive, { force });
  console.log(`Restored workspace ${name} (${id}). Restart the app to load the restored state.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
