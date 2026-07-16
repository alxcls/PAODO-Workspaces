// Display order for the file tree, shared by the renderer and by shift+click range selection so the
// two can never disagree about which rows lie between two clicks.

import type { TreeNode } from "./hooks/useFileOperations";

/** Directories before files, each group alphabetical — the order every level renders in. */
export function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Every node at or below `nodes`, in display order. */
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  return sortTreeNodes(nodes).flatMap((n) => [n, ...flattenTree(n.children ?? [])]);
}

/** The rows currently on screen, top to bottom: a collapsed folder hides its subtree. */
export function flattenVisible(nodes: TreeNode[], expanded: Record<string, boolean>): TreeNode[] {
  return sortTreeNodes(nodes).flatMap((n) =>
    n.type === "directory" && (expanded[n.path] ?? false) ? [n, ...flattenVisible(n.children ?? [], expanded)] : [n],
  );
}

/** A node's own path plus every path beneath it — checking a folder means checking its contents. */
export function pathWithDescendants(node: TreeNode): string[] {
  return [node.path, ...flattenTree(node.children ?? []).map((n) => n.path)];
}

/**
 * The paths a shift+click should add: every visible row between the anchor and the clicked row,
 * inclusive, each carrying its subtree. Clicking above the anchor is the same range as clicking
 * below it. Falls back to the clicked row alone when the anchor is no longer on screen — collapsing
 * its folder can take it away between the two clicks.
 */
export function selectionRange(visibleRows: TreeNode[], anchorPath: string | null, targetPath: string): string[] {
  const targetIndex = visibleRows.findIndex((n) => n.path === targetPath);
  if (targetIndex === -1) return [];
  const anchorIndex = anchorPath === null ? -1 : visibleRows.findIndex((n) => n.path === anchorPath);
  if (anchorIndex === -1) return pathWithDescendants(visibleRows[targetIndex]);

  const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return visibleRows.slice(start, end + 1).flatMap(pathWithDescendants);
}
