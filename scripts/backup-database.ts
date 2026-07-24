import path from "path";
import { backupAppDataDb } from "../lib/data/database";

async function main(): Promise<void> {
  const destination = process.argv[2];
  if (!destination) {
    throw new Error("Usage: npm run backup:database -- /path/on/backup-storage/paodo.db");
  }
  const resolved = path.resolve(destination);
  await backupAppDataDb(resolved);
  console.log(`Database backed up to ${resolved}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
