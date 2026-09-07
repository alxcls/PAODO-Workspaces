// Console reporting for the backup command, so an archive reads the same however it is inspected.
// Lives here rather than in lib/ because printing to a terminal is a command's concern.
import type { ArchiveManifest } from "../lib/archive/manifest";

interface ArchiveWritten {
  path: string;
  bytes: number;
  manifest: ArchiveManifest;
}

export function reportArchived(label: string, result: ArchiveWritten): void {
  const members = result.manifest.contents.map((member) => member.name).join(", ");
  console.log(`Archived ${label} to ${result.path} (${result.bytes} bytes)`);
  console.log(`Members: ${members}`);
}
