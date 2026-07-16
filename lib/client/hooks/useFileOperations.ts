// Manages the workspace file tree and bulk operations on the current selection. Fetches the tree
// from the files route (re-fetching when refreshKey changes), and provides download (zips the
// selected paths) and delete actions. Delete collapses the selection to root paths (skipping
// descendants of an already-selected folder), issues the DELETEs in parallel, aggregates any
// failures into a transient deleteError (auto-cleared after 2s), and notifies the parent of
// deleted paths so dependent views can update. Internal tree drag-and-drop also comes through here:
// handleMoveMany sends the whole dragged batch as one contained PATCH, reports conflicts, and
// returns the authoritative new path of each item the server moved.

import { useState, useEffect, useCallback, useRef } from "react";
import { collapseToRoots } from "../fileMove";
import { useDeferredPending } from "./useDeferredPending";
import { useTransientMessage } from "./useTransientMessage";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

/** What the server did with one item of a move batch. */
export interface MoveResult {
  sourcePath: string;
  /** The item's authoritative new path — equal to sourcePath when unchanged. */
  path: string;
  /** The item was already in the destination, so nothing moved. */
  unchanged: boolean;
}

export interface MoveBatchOutcome {
  results: MoveResult[];
  error: string | null;
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
  const [deleteError, setDeleteError] = useTransientMessage(2000);
  const [moveError, setMoveError] = useTransientMessage(3500);
  const moveInFlightRef = useRef(false);

  const fetchTree = useCallback(async () => {
    try {
      const res = await fetch(`${base}/files`);
      if (!res.ok) return;
      const { tree: data } = (await res.json()) as { tree: TreeNode[] };
      setTree(data);
    } catch {
      /* silent */
    }
  }, [base]);

  useEffect(() => {
    // fetchTree updates state only after its asynchronous request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTree();
  }, [fetchTree, refreshKey]);

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
    const roots = collapseToRoots(paths);
    setDeleteError(null);
    const failures: string[] = [];
    try {
      const resArr = await Promise.all(
        roots.map((p) =>
          fetch(`${base}/files/content?path=${encodeURIComponent(p)}`, {
            method: "DELETE",
          }),
        ),
      );
      for (const r of resArr) {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}) as { error?: string; message?: string });
          failures.push((body.error || body.message) ?? `${r.status} ${r.statusText}`);
        }
      }
      if (failures.length > 0) {
        const uniq = Array.from(new Set(failures));
        setDeleteError(uniq.length === 1 ? `Failed to delete: ${uniq[0]}` : `Failed to delete: ${uniq.join("; ")}`);
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

  /**
   * Move a batch of items into one directory with a single request, and refresh the tree once.
   *
   * Resolves to the per-item results the server actually performed, plus the error that stopped the
   * batch if one did — a partial move reports both. Resolves to null only when the request itself
   * could not be made sense of. `unchanged` is the server's own verdict that the item was already
   * in the destination: never re-derive it by comparing paths, since the tree's paths and the
   * server's realpaths need not be identical.
   */
  const handleMoveMany = async (
    sourcePaths: string[],
    destinationDirectory: string | null,
  ): Promise<MoveBatchOutcome | null> => {
    if (moveInFlightRef.current) {
      setMoveError("Another move is still in progress");
      return null;
    }
    moveInFlightRef.current = true;
    setMoveError(null);
    try {
      const res = await fetch(`${base}/files/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePaths, destinationDirectory }),
      });
      const body = (await res.json().catch(() => ({}))) as { results?: MoveResult[]; error?: string };
      // A rejected batch still carries results (an empty list); only a malformed request omits them.
      if (!Array.isArray(body.results)) {
        setMoveError(body.error || `Move failed: ${res.status} ${res.statusText}`);
        return null;
      }
      if (body.error) setMoveError(body.error);
      await fetchTree();
      return { results: body.results, error: body.error ?? null };
    } catch {
      setMoveError("Move failed");
      return null;
    } finally {
      moveInFlightRef.current = false;
    }
  };

  return {
    tree,
    fetchTree,
    handleDownload,
    downloading,
    handleDelete,
    deleteError,
    handleMoveMany,
    moveError,
  };
}
