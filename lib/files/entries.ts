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

/** What one bounded read saw, and whether it stopped early. */
export interface ListingEntries {
  entries: Dirent[];
  /** The scan hit `maxEntries` before the end of the directory, so `entries` is a prefix of it. */
  truncated: boolean;
}

/**
 * The same entries, for a listing rather than a transfer: at most `maxEntries` of them, and a flag
 * saying whether that ceiling is the reason the list ends where it does.
 *
 * A separate function rather than an argument to the one above, because the two answer different
 * questions and a cap would be wrong in the other. An archive or a manifest that quietly carried a
 * prefix of a directory would present a short answer as the whole tree — the failure this module's
 * header already refuses to make a shared default. A listing is navigation, where the ceiling is
 * exactly what keeps one pathological directory from being an unbounded allocation, and where saying
 * "there is more here" is a usable answer.
 *
 * opendir rather than readdir, so the ceiling bounds the scan and not just its output: readdir
 * materializes a Dirent for every name in the directory before this code sees any of them, which on a
 * drive holding a million files is an allocation no container limit sits above — drives are read
 * host-side. Streaming means the cap is reached and the rest is never built. Same reasoning, and the
 * same mechanism, as the agent's drive_ls (lib/agent/tools/driveLs.ts).
 *
 * Counted after the ignore contract, not before, so the ceiling is on what a caller can actually see.
 * A directory of a million ignored files is still walked in full — nothing can know what survives
 * without looking — but it is walked without retaining any of it.
 *
 * The descriptor slot is held for the whole iteration rather than per batch, because opendir keeps the
 * directory handle open across it; releasing between reads would hand the budget a descriptor it does
 * not in fact have back.
 */
export async function readListingEntries(
  dirPath: string,
  sem: Semaphore,
  maxEntries: number,
  contract: IgnoreContract = IGNORE_CONTRACT,
): Promise<ListingEntries> {
  return sem.run(async () => {
    const entries: Dirent[] = [];
    let truncated = false;
    const dir = await fs.opendir(dirPath);
    // `for await` closes the handle itself — on a `break` and on a throw, not only on completion — so
    // an explicit close here would just hit ERR_DIR_CLOSED.
    for await (const entry of dir) {
      if (ignoreRuleFor(entry.name, entry.isDirectory(), contract) !== undefined) continue;
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    return { entries, truncated };
  });
}
