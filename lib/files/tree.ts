// Shared file-tree walker for the workspace and drive file-panel routes.
// Recursively walks a directory, skipping whatever the shared ignore contract excludes (./ignore.ts).
// Kept here, shared and tested once, rather than copy-pasted into each route.
//
// The depth cap is the panel's, not the filesystem's: it exists so one pathological tree cannot make
// the file panel's single JSON response unbounded, and it is a named option rather than a literal
// buried in the recursion, because the panel's budget is not every caller's. A client that navigates
// asks for one level and lists again to descend (the CLI's `paodo <workspace|drive> file ls`); one that must see the
// whole tree passes Infinity and gets it. Both are `?depth=` on the tree route.
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { readListingEntries, readTransferEntries } from "./entries";
import { openFileLimiter, type Semaphore } from "./fdLimit";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  /**
   * Workspace-relative, POSIX-separated — the one path space the file API speaks (./relpath.ts).
   * It used to be the absolute host path, which made the server's directory layout part of the wire
   * contract and left a non-browser client no way to name a file at all.
   */
  path: string;
  children?: TreeNode[];
  /**
   * How many lines the content route would find in this file, so a caller can choose an `?offset=` and
   * `?limit=` before reading rather than by overshooting and reading again.
   *
   * Present only when the caller asked to measure the listing, and then only for a file that is text —
   * an image or an archive has no lines to count. See listEntries.
   */
  lines?: number;
  /**
   * Every file at any depth under this directory, counted through the same ignore contract that decides
   * what the listing shows — so it counts what a caller could go on to read or transfer, and a
   * `node_modules` is as absent from the number as it is from the tree.
   *
   * Recursive rather than a count of direct children, because the question it answers is whether a
   * directory is worth descending into, and a folder holding three subfolders and fourteen thousand
   * files is exactly the one a direct count would call small. Directories are not counted: they are the
   * structure, not the content, so `0` means there is nothing here to read however many folders deep it
   * goes.
   *
   * Present only when the caller asked to count, and only on directories. See listEntries.
   */
  files?: number;
  /**
   * This directory's own listing stopped at the caller's `maxEntries` ceiling, so `children` is a
   * prefix of what is really here — and an arbitrary one, since the cut happens in filesystem order
   * before anything sorts.
   *
   * Present only when it is true, and only on a directory that was actually cut. A listing that was
   * whole says nothing, for the reason the tree route stopped serving `truncated` on every response:
   * a flag that is almost always false is one a reader learns to skip.
   */
  truncated?: boolean;
}

/** What the file panel renders in one response. */
export const FILE_PANEL_MAX_DEPTH = 5;

export interface BuildTreeOptions {
  /** Levels to descend before stopping. Infinity walks the whole tree. */
  maxDepth?: number;
  /**
   * The most entries to return for any one directory. Defaults to Infinity — the file panel renders
   * whatever is there, as it always has, and a ceiling it did not ask for would silently shorten a
   * tree the user is looking at.
   *
   * A client that navigates passes one, because breadth is the half of a listing `maxDepth` does not
   * bound: one level of a directory holding a million files is a bounded depth and an unbounded
   * answer. See readListingEntries for why the ceiling stops the scan and not just the output.
   */
  maxEntries?: number;
  /**
   * The wire path of `rootDir` itself, for a walk that starts somewhere below the workspace root.
   * Every node's `path` is built from it, so listing one subdirectory names its entries exactly as
   * listing the whole workspace would — which is what keeps those paths valid arguments to the other
   * file routes, with no rejoining for the caller to get wrong. Defaults to "", the root.
   */
  basePath?: string;
  /**
   * Give every directory a `files` count of everything underneath it.
   *
   * Opt-in for the reason `measure` is: it costs a readdir per directory in the whole subtree, which a
   * shallow listing does not otherwise pay — a one-level `ls` of the root has to descend all of it to
   * answer. A listing walked to full depth gets the counts for nothing, since the walk has already been
   * everywhere the count would go.
   */
  countFiles?: boolean;
}

/** A finished tree, and whether any directory in it was cut short by the entry ceiling. */
export interface BuiltTree {
  nodes: TreeNode[];
  /**
   * Some directory in this tree hit `maxEntries`. Aggregated up the walk rather than left only on the
   * node it happened to, because the directory that was cut may be the root — which has no node to
   * carry a flag — and because a caller that must not present a prefix as the whole answer should not
   * have to search the tree to find out that it is one. The node still carries its own flag, so the
   * caller can find where.
   */
  truncated: boolean;
}

export async function buildTree(rootDir: string, options: BuildTreeOptions = {}): Promise<BuiltTree> {
  const maxDepth = options.maxDepth ?? FILE_PANEL_MAX_DEPTH;
  const walked = await walk(
    rootDir,
    options.basePath ?? "",
    0,
    maxDepth,
    options.maxEntries ?? Infinity,
    openFileLimiter(),
    options.countFiles === true,
  );
  return { nodes: walked.nodes, truncated: walked.truncated };
}

/** The nodes of one directory, and — when counting — every file underneath it, however deep. */
interface WalkResult {
  nodes: TreeNode[];
  files: number;
  /** This directory's own listing stopped at the ceiling. What the node's flag is built from. */
  cut: boolean;
  /** This directory or anything below it stopped. The aggregate, and only BuiltTree carries it. */
  truncated: boolean;
}

/**
 * `relPath` is carried down the recursion rather than derived per node with path.relative: the walker
 * already knows where it is, and building the wire path from the segments it descended through is both
 * cheaper and impossible to get subtly wrong on a root that is itself a symlink.
 *
 * The file count comes back up the same recursion rather than from a second pass over the finished tree,
 * because the tree stops at `maxDepth` and the count does not: below the cut there are no nodes left to
 * add up. That is also the only place the count costs anything extra — see countFilesUnder.
 */
async function walk(
  dirPath: string,
  relPath: string,
  depth: number,
  maxDepth: number,
  maxEntries: number,
  sem: Semaphore,
  countFiles: boolean,
): Promise<WalkResult> {
  // Past the caller's depth, the tree stops but the count must not: this is exactly the directory whose
  // size a caller cannot see, since it is being handed an empty branch.
  if (depth >= maxDepth) {
    return { nodes: [], files: countFiles ? await countFilesUnder(dirPath, sem) : 0, cut: false, truncated: false };
  }
  let read;
  try {
    read = await readListingEntries(dirPath, sem, maxEntries);
  } catch (err) {
    // An unreadable directory renders as an empty branch rather than failing the panel: the tree is
    // navigation, and one bad directory should not blank the whole file list.
    createLogger("api").warn({ err, dirPath }, "failed to read directory in file tree");
    return { nodes: [], files: 0, cut: false, truncated: false };
  }

  const entryResults = await Promise.all(
    read.entries.map(async (e): Promise<{ node: TreeNode; files: number; truncated: boolean }> => {
      const hostPath = path.join(dirPath, e.name);
      const entryRelPath = relPath === "" ? e.name : `${relPath}/${e.name}`;
      if (e.isDirectory()) {
        const below = await walk(hostPath, entryRelPath, depth + 1, maxDepth, maxEntries, sem, countFiles);
        return {
          node: {
            name: e.name,
            type: "directory",
            path: entryRelPath,
            children: below.nodes,
            ...(countFiles ? { files: below.files } : {}),
            // `cut`, not `truncated`: the flag names the directory whose own listing stopped, so a
            // caller can find it. An ancestor that was listed whole is not a short answer.
            ...(below.cut ? { truncated: true } : {}),
          },
          files: below.files,
          truncated: below.truncated,
        };
      }
      return { node: { name: e.name, type: "file", path: entryRelPath }, files: 1, truncated: false };
    }),
  );

  return {
    // Promise.all preserves input order regardless of resolution order, so entries keep readdir's order.
    nodes: entryResults.map((r) => r.node),
    files: entryResults.reduce((sum, r) => sum + r.files, 0),
    cut: read.truncated,
    truncated: read.truncated || entryResults.some((r) => r.truncated),
  };
}

/**
 * Every file under `dirPath`, counted without building nodes for any of it — what the count needs below
 * the depth the tree stopped at.
 *
 * Through the same reader the walk uses, so the number is of the same tree the caller is looking at: a
 * count that included what the listing hides would describe a directory the caller cannot navigate. An
 * unreadable directory contributes nothing, the same empty answer the walk gives it above.
 */
async function countFilesUnder(dirPath: string, sem: Semaphore): Promise<number> {
  let entries;
  try {
    entries = await readTransferEntries(dirPath, sem);
  } catch (err) {
    createLogger("api").warn({ err, dirPath }, "failed to read directory while counting a file tree");
    return 0;
  }

  const counts = await Promise.all(
    entries.map((e) => (e.isDirectory() ? countFilesUnder(path.join(dirPath, e.name), sem) : Promise.resolve(1))),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}
