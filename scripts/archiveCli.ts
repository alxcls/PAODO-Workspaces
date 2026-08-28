// Console reporting shared by both backup commands, so one archive reads the same whichever wrote
// it. Lives here rather than in lib/ because printing to a terminal is a command's concern.
import { verifyArchive } from "../lib/infra/archive/core";
import { isWorkspaceManifest } from "../lib/workspace/archive";
import type { ArchiveManifest } from "../lib/archive/manifest";

interface ArchiveWritten {
  path: string;
  bytes: number;
  manifest: ArchiveManifest;
}

/** Names the workspace when the archive holds one, so --verify identifies the file, not just its kind. */
function describe(manifest: ArchiveManifest): string {
  if (!isWorkspaceManifest(manifest)) return `${manifest.kind} archive`;
  return `${manifest.workspace.name} (${manifest.workspace.id})`;
}

export function reportArchived(label: string, result: ArchiveWritten): void {
  const members = result.manifest.contents.map((member) => member.name).join(", ");
  console.log(`Archived ${label} to ${result.path} (${result.bytes} bytes)`);
  console.log(`Members: ${members}`);
}

/** Throws on a failed check so the command exits non-zero: a bad archive must not read as success. */
export async function verifyAndReport(archivePath: string): Promise<void> {
  const result = await verifyArchive(archivePath);
  const { source, contents } = result.manifest;
  console.log(`${describe(result.manifest)} from ${source.deployment} captured ${source.capturedAt} on ${source.host}`);
  for (const member of contents) console.log(`  ${member.name}  ${member.bytes} bytes`);
  if (result.ok) {
    console.log("Archive verified: every member matches its recorded hash.");
    return;
  }
  for (const problem of result.problems) console.error(`  ! ${problem}`);
  throw new Error("Archive verification failed.");
}
