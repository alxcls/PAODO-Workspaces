import path from "path";
import { backupDataDb } from "../lib/workspace/dataDb";

async function main(): Promise<void> {
  const destination = process.argv[2];
  if (!destination) {
    throw new Error("Usage: npm run backup:workspace-data -- /path/on/backup-storage/workspace.db");
  }
  const resolved = path.resolve(destination);
  await backupDataDb(resolved);
  console.log(`Workspace data backed up to ${resolved}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
