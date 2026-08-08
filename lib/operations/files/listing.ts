// Listing one directory of a workspace: the caller's own path in, the file panel's nested tree out.
//
// The walk itself is lib/files/tree.ts, shared with the drive route. What lives here is the half a
// route must not do for itself (./paths.ts): turning a caller-supplied path into a host path, and a
// filesystem errno into the public error vocabulary. Without it, a listing scoped to a subdirectory
// would have to either trust the string or answer an empty tree for a path that does not exist — and
// "nothing is there" is the wrong answer to "that is not a path".

import fs from "fs/promises";
import path from "path";
import { buildTree, type TreeNode } from "@/lib/files/tree";
import { openFileLimiter, type Semaphore } from "@/lib/files/fdLimit";
import { countLines, readFileEntry } from "./content";
import { fileSystemCall } from "./errors";
import { requireDirPath, resolveHostPath } from "./paths";

/**
 * The largest file a listing will read in order to count its lines.
 *
 * There has to be a bound, because measuring is the one thing a listing does whose cost is the size of
 * the workspace rather than the shape of it, and `?depth=full` over a directory holding a multi-gigabyte
 * log would otherwise read it to answer a question about names. Past this the entry carries no `lines`,
 * the same as a file that has none to count.
 */
const MAX_MEASURED_BYTES = 4 * 1024 * 1024;

export interface ListEntriesOptions {
  /** Levels to descend, counted from the directory listed. Infinity walks all of it. */
  maxDepth?: number;
  /**
   * Add `lines` to every file that is text and under MAX_MEASURED_BYTES.
   *
   * Off by default, and the file panel never asks for it: a line count can only be had by reading the
   * file, so measuring turns a listing of N names into N reads. It exists for the caller that reads
   * files one window at a time — `paodo file cat --offset --limit` — which otherwise has to discover
   * how long a file is by running off the end of it.
   */
  measure?: boolean;
  /**
   * Add `files` to every directory: everything underneath it, however deep.
   *
   * Off by default and paid for only when asked, like `measure` above — a one-level listing has to walk
   * the whole subtree to answer, so the cost of an `ls` stops being the shape of the directory listed and
   * becomes the size of the tree below it. It exists for a caller deciding where to go next rather than
   * rendering what it already has: a directory of three entries holding fourteen thousand files is worth
   * knowing about before descending, and the tree alone cannot say so.
   */
  countFiles?: boolean;
}

/**
 * The entries under `pathValue`, which names a directory inside the workspace — `null`, `undefined`,
 * "" and "." all meaning the root, so a caller that wants everything passes nothing.
 *
 * Two things a caller depends on:
 *
 *   - Every node's `path` is named from the workspace root, not from the directory listed, so a path
 *     this returns can be handed straight back to the content, transfer and delete routes.
 *   - A path naming a file answers with that one file rather than failing, the way `ls` of a file
 *     does. The caller asked what is at that path, and "a file" and "nothing" are different answers.
 *     It is also what the sibling transfer route already does with the same parameter (./transfer.ts).
 */
export async function listEntries(
  rootDir: string,
  pathValue: unknown,
  options: ListEntriesOptions = {},
): Promise<TreeNode[]> {
  const relPath = requireDirPath(pathValue);
  const hostPath = await resolveHostPath(rootDir, relPath);
  // stat, not lstat: resolveHostPath has already refused a symlink that leaves the workspace, and a
  // contained one is followed here for the same reason a read follows it — the tree lists such a link
  // as an ordinary row, so listing through it is the same permission as reading through it.
  const stat = await fileSystemCall(relPath || "The workspace root", () => fs.stat(hostPath));
  const tree = stat.isDirectory()
    ? await buildTree(hostPath, { maxDepth: options.maxDepth, basePath: relPath, countFiles: options.countFiles })
    : [{ name: path.posix.basename(relPath), type: "file" as const, path: relPath }];
  if (options.measure) await measure(rootDir, tree, openFileLimiter());
  return tree;
}

/**
 * Annotates every file in `nodes` in place with what it costs to read.
 *
 * A second pass over the finished tree rather than a branch inside the walk, because the walk is shared
 * with the file panel, which must never pay for this — and because the pass is over nodes already in
 * memory, so the only cost it adds is the reads it was asked to make. Through the same descriptor
 * budget the walk used, so a wide directory cannot open a file handle per entry at once.
 *
 * A file that cannot be read is left unmeasured rather than failing the listing, for the reason the
 * walker already logs and continues on: this is navigation, and one unreadable file should not turn a
 * question about names into an error.
 */
async function measure(rootDir: string, nodes: TreeNode[], sem: Semaphore): Promise<void> {
  await Promise.all(
    nodes.map(async (node) => {
      if (node.type === "directory") return measure(rootDir, node.children ?? [], sem);
      try {
        const hostPath = await resolveHostPath(rootDir, node.path);
        // Sized before it is read, and never reported: the size is only ever the reason this stops.
        const { size } = await sem.run(() => fs.stat(hostPath));
        if (size > MAX_MEASURED_BYTES) return;
        // Read through the content operation, not a decode of our own: `lines` is only worth reporting
        // if it is the same count the read route would slice against, and that route's idea of which
        // files have lines at all — an SVG is an image, not text — is decided by this classification.
        const file = await sem.run(() => readFileEntry(rootDir, node.path));
        if (file.type === "text") node.lines = countLines(file.content);
      } catch {
        // Unmeasured: the entry keeps its name, which is what a listing is for.
      }
    }),
  );
}
