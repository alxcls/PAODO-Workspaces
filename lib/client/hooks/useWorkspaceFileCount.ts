// Counts the files in a workspace's tree for the home page's summary line. Returns null while the
// count is unknown — on mount, on every workspace switch, and when no workspace is selected — so
// the caller can omit the segment entirely instead of flashing a stale or zero count. A failed
// fetch resolves to 0 (the tree endpoint 404s for a workspace with no files yet).
"use client";

import { useState, useEffect } from "react";

interface TreeNode {
  type: "file" | "directory";
  children?: TreeNode[];
}

function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file") n++;
    else n += countFiles(node.children ?? []);
  }
  return n;
}

export function useWorkspaceFileCount(workspaceId: string | null): number | null {
  const [counted, setCounted] = useState<{ id: string; count: number } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/files`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setCounted({ id: workspaceId, count: countFiles((data as { tree: TreeNode[] }).tree ?? []) });
      })
      .catch(() => {
        if (!cancelled) setCounted({ id: workspaceId, count: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Tagging the count with the workspace it was computed for makes "unknown" a derived value
  // rather than a reset write in the effect body: a count belonging to the previous selection
  // reads as null until this workspace's fetch lands, with no extra render pass.
  return counted && counted.id === workspaceId ? counted.count : null;
}
