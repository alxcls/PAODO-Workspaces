// Ranking of file-tree candidates against a typed mention query, plus a display-only path shortener.
// Pure so the ordering and truncation rules can be pinned by unit tests.

import type { TreeNode } from "./hooks/useFileOperations";

/** The basename (last segment) of a POSIX path. */
function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Lower rank = better match: basename prefix, then basename substring, then anywhere in the path. */
function matchRank(path: string, query: string): number | null {
  const name = basename(path).toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (path.toLowerCase().includes(query)) return 2;
  return null;
}

/**
 * Candidates matching `query`, best first, capped at `limit`. An empty query keeps the incoming order
 * (already directories-first, alphabetical from flattenTree). Matches are ranked by matchRank and
 * ties broken by original order, so the list is stable as the user types.
 */
export function filterMentions(candidates: TreeNode[], query: string, limit: number): TreeNode[] {
  const q = query.toLowerCase();
  if (!q) return candidates.slice(0, limit);

  const ranked: { node: TreeNode; rank: number; index: number }[] = [];
  candidates.forEach((node, index) => {
    const rank = matchRank(node.path, q);
    if (rank !== null) ranked.push({ node, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.slice(0, limit).map((r) => r.node);
}

/**
 * Shorten a path for display by dropping leading ancestors, keeping the tail (the most identifying
 * part) and prefixing "…/". The basename is never truncated. Returns the path unchanged when it fits.
 */
export function truncateMiddlePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  let out = name;
  for (let i = segments.length - 2; i >= 0; i--) {
    const candidate = segments[i] + "/" + out;
    if (candidate.length + 2 > maxLen) break;
    out = candidate;
  }
  return "…/" + out;
}
