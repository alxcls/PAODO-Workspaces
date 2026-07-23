import path from "path";
import { backupUsage } from "../lib/workspace/usageStore";

async function main(): Promise<void> {
  const destination = process.argv[2];
  if (!destination) {
    throw new Error("Usage: npm run backup:usage -- /path/on/backup-storage/usage.db");
  }
  const resolved = path.resolve(destination);
  await backupUsage(resolved);
  console.log(`Usage database backed up to ${resolved}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
