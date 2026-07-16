// Manages the workspace file tree and bulk operations on the current selection. Fetches the tree
// from the files route (re-fetching when refreshKey changes), and provides download (zips the
// selected paths) and delete actions. Delete collapses the selection to root paths (skipping
// descendants of an already-selected folder), issues the DELETEs in parallel, aggregates any
// failures into a transient deleteError (auto-cleared after 2s), and notifies the parent of
// deleted paths so dependent views can update. Internal tree drag-and-drop also comes through here:
// handleMove issues a contained PATCH, reports conflicts, and returns the authoritative new path.

import { useState, useEffect, useCallback, useRef } from "react";
import { useDeferredPending } from "./useDeferredPending";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

interface Options {
  workspaceId: string;
  workspaceName: string;
  selected: Set<string>;
  clearSelection: () => void;
  onDeletedPaths?: (paths: string[]) => void;
  refreshKey?: number;
  /** API base for file routes. Defaults to the workspace path; drives pass /api/drives/<id>. */
  apiBase?: string;
}

export function useFileOperations({
  workspaceId,
  workspaceName,
  selected,
  clearSelection,
  onDeletedPaths,
  refreshKey,
  apiBase,
}: Options) {
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;
  const [tree, setTree] = useState<TreeNode[]>([]);
  const { pending: downloading, run: runDownload } = useDeferredPending();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const deleteTimerRef = useRef<number | null>(null);
  const moveTimerRef = useRef<number | null>(null);
  const moveInFlightRef = useRef(false);

  useEffect(() => {
    if (!deleteError) return;
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    deleteTimerRef.current = window.setTimeout(() => {
      setDeleteError(null);
      deleteTimerRef.current = null;
    }, 2000);
    return () => {
      if (deleteTimerRef.current) {
        clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
    };
  }, [deleteError]);

  useEffect(() => {
    if (!moveError) return;
    if (moveTimerRef.current) window.clearTimeout(moveTimerRef.current);
    moveTimerRef.current = window.setTimeout(() => {
      setMoveError(null);
      moveTimerRef.current = null;
    }, 3500);
    return () => {
      if (moveTimerRef.current) window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = null;
    };
  }, [moveError]);

  const fetchTree = useCallback(async () => {
    try {
      const res = await fetch(`${base}/files`);
      if (!res.ok) return;
      const { tree: data } = (await res.json()) as { tree: TreeNode[] };
      setTree(data);
    } catch { /* silent */ }
  }, [base]);

  useEffect(() => { fetchTree(); }, [fetchTree, refreshKey]);

  const handleDownload = () =>
    runDownload(async () => {
      const res = await fetch(`${base}/files/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: Array.from(selected) }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${workspaceName}.zip`;
      // The anchor must be in the DOM for Firefox to honor the click, and the object URL must outlive
      // the click — modern browsers cancel the download if it's revoked synchronously, so defer it.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });

  const handleDelete = async () => {
    const paths = Array.from(selected);
    const roots = paths.filter(
      (p) => !paths.some((other) => other !== p && p.startsWith(other + "/"))
    );
    setDeleteError(null);
    const failures: string[] = [];
    try {
      const resArr = await Promise.all(
        roots.map((p) =>
          fetch(`${base}/files/content?path=${encodeURIComponent(p)}`, {
            method: "DELETE",
          })
        )
      );
      for (const r of resArr) {
        if (!r.ok) {
          const body = await r.json().catch(() => ({} as { error?: string; message?: string }));
          failures.push((body.error || body.message) ?? `${r.status} ${r.statusText}`);
        }
      }
      if (failures.length > 0) {
        const uniq = Array.from(new Set(failures));
        setDeleteError(
          uniq.length === 1
            ? `Failed to delete: ${uniq[0]}`
            : `Failed to delete: ${uniq.join("; ")}`
        );
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
    if (failures.length === 0) {
      clearSelection();
      onDeletedPaths?.(paths);
    }
    fetchTree();
  };

  // Resolves to the item's new path, or null when the move did not happen. `unchanged` reports the
  // server's own verdict that the item was already in the destination — never re-derive that by
  // comparing paths, since the tree's paths and the server's realpaths need not be identical.
  const handleMove = async (
    sourcePath: string,
    destinationDirectory: string | null,
  ): Promise<{ path: string; unchanged: boolean } | null> => {
    if (moveInFlightRef.current) {
      setMoveError("Another move is still in progress");
      return null;
    }
    moveInFlightRef.current = true;
    setMovingPath(sourcePath);
    setMoveError(null);
    try {
      const res = await fetch(`${base}/files/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePath, destinationDirectory }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { path?: string; unchanged?: boolean; error?: string };
      if (!res.ok || !body.path) {
        setMoveError(body.error || `Move failed: ${res.status} ${res.statusText}`);
        return null;
      }
      await fetchTree();
      return { path: body.path, unchanged: body.unchanged === true };
    } catch {
      setMoveError("Move failed");
      return null;
    } finally {
      moveInFlightRef.current = false;
      setMovingPath(null);
    }
  };

  return {
    tree, fetchTree,
    handleDownload, downloading,
    handleDelete, deleteError,
    handleMove, movingPath, moveError,
  };
}
