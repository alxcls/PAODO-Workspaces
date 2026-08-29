// Ahead of the lib imports: paths.ts reads WORKSPACES_ROOT at module load, and PAODO_DEPLOYMENT is
// fatal when unset, so both have to be in the environment before either module evaluates.
import "dotenv/config";
import os from "os";
import path from "path";
import { mkdtemp, rm } from "fs/promises";
import { verifySet } from "../lib/infra/backup/setTransfer";
import { s3Source } from "../lib/infra/backup/s3Source";
import { SET_MANIFEST_MEMBER } from "../lib/archive/setManifest";

const USAGE = `Usage:
  npm run backup:verify-remote -- <instance/stamp-id>
  npm run backup:verify-remote -- --list <instance>`;

async function list(instance: string): Promise<void> {
  const sets = await s3Source().listSets(instance);
  if (sets.length === 0) {
    console.log(`No complete sets under ${instance}/.`);
    return;
  }
  for (const set of sets) console.log(set);
}

async function verify(prefix: string): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "verify-remote-"));
  try {
    const result = await verifySet(prefix, workDir);
    for (const problem of result.problems) console.error(`  ! ${problem}`);
    if (!result.ok) throw new Error(`Remote set ${prefix} failed verification.`);
    console.log(`Set ${prefix} verified: ${result.manifest!.entries.length} members match ${SET_MANIFEST_MEMBER}.`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    if (!args[1]) throw new Error(USAGE);
    await list(args[1]);
    return;
  }
  if (!args[0]) throw new Error(USAGE);
  await verify(args[0]);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
