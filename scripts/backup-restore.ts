// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import { restoreSet } from "../lib/infra/backup/restoreSet";

const USAGE = `Usage:
  npm run backup:restore -- <set-dir> [--force]

Applies a restic-restored backup set back onto this deployment. Overwriting existing state,
or restoring a set captured on another deployment, requires --force.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const setDir = args.find((arg) => !arg.startsWith("--"));
  if (!setDir) throw new Error(USAGE);

  const { manifest, workspaces, pruned } = await restoreSet(setDir, { force });

  console.log(`Restored set ${manifest.instance}/${manifest.id} captured ${manifest.source.capturedAt}.`);
  const names = workspaces.map((w) => `${w.name} (${w.id})`).join(", ");
  console.log(`Workspaces: ${workspaces.length ? names : "none"}`);
  if (pruned.length) console.log(`Pruned ${pruned.length} workspace(s) absent from the set: ${pruned.join(", ")}`);
  console.log("Database, registry, graph and drives restored. Restart the app to load the restored state.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
