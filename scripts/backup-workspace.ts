import { execFileSync } from "child_process";
import { archiveWorkspace, verifyArchive } from "../lib/infra/workspace/archive";
import { hashDockerfile } from "../lib/infra/docker/dockerfileHasher";
import { getStore } from "../lib/infra/services";

/** Which build produced the archive. Absent in a deployed container, which ships no .git. */
function paodoCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const USAGE = `Usage:
  npm run backup:workspace -- <workspace-id|name> <destination-dir-or-file>
  npm run backup:workspace -- --verify <archive.tar>`;

async function verify(archivePath: string): Promise<void> {
  const result = await verifyArchive(archivePath);
  const { workspace, source, contents } = result.manifest;
  console.log(`${workspace.name} (${workspace.id}) captured ${source.capturedAt} on ${source.host}`);
  for (const member of contents) console.log(`  ${member.name}  ${member.bytes} bytes`);
  if (result.ok) {
    console.log("Archive verified: every member matches its recorded hash.");
    return;
  }
  for (const problem of result.problems) console.error(`  ! ${problem}`);
  throw new Error("Archive verification failed.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--verify") {
    if (!args[1]) throw new Error(USAGE);
    await verify(args[1]);
    return;
  }

  const [selector, destination] = args;
  if (!selector || !destination) throw new Error(USAGE);

  const store = getStore();
  const workspace = store.getWorkspace(selector) ?? store.getWorkspaceByName(selector);
  if (!workspace) throw new Error(`No workspace matches "${selector}".`);

  const ref = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
  const result = await archiveWorkspace(workspace, destination, {
    image: { ref, hash: await hashDockerfile("Dockerfile.workspace") },
    paodoCommit: paodoCommit(),
  });

  const members = result.manifest.contents.map((member) => member.name).join(", ");
  console.log(`Archived ${workspace.name} to ${result.path} (${result.bytes} bytes)`);
  console.log(`Members: ${members}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
