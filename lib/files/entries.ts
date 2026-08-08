// Reading one directory the way every workspace traversal must read it: through the shared
// descriptor budget, with the shared ignore contract already applied.
//
// This is the seam the three traversals had each grown their own version of — the file tree filtered
// one list inline, the download zip filtered nothing, and a manifest walk would have needed a third
// copy. Putting the readdir here means "what does this directory contain, as far as a transfer is
// concerned" has exactly one answer.
//
// Error policy is deliberately NOT decided here: readdir failures propagate. The callers want
// different things from an unreadable directory — the file tree logs and shows an empty branch so the
// panel still renders, while an archive or a manifest must report the gap rather than quietly present
// a short answer as the whole tree — and a shared default would silently pick one of those for the
// other.
import fs from "fs/promises";
import type { Dirent } from "fs";
import { ignoreRuleFor, type IgnoreContract, IGNORE_CONTRACT } from "./ignore";
import type { Semaphore } from "./fdLimit";

/**
 * The entries of `dirPath` that a transfer is allowed to see, in readdir order. Throws whatever
 * readdir throws.
 */
export async function readTransferEntries(
  dirPath: string,
  sem: Semaphore,
  contract: IgnoreContract = IGNORE_CONTRACT,
): Promise<Dirent[]> {
  const entries = await sem.run(() => fs.readdir(dirPath, { withFileTypes: true }));
  return entries.filter((entry) => ignoreRuleFor(entry.name, entry.isDirectory(), contract) === undefined);
}
