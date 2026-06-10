import { useState, useEffect, useCallback, useRef } from "react";

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
}

export function useFileOperations({
  workspaceId,
  workspaceName,
  selected,
  clearSelection,
  onDeletedPaths,
  refreshKey,
}: Options) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTimerRef = useRef<number | null>(null);

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

  const fetchTree = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files`);
      if (!res.ok) return;
      const { tree: data } = (await res.json()) as { tree: TreeNode[] };
      setTree(data);
    } catch { /* silent */ }
  }, [workspaceId]);

  useEffect(() => { fetchTree(); }, [fetchTree, refreshKey]);

  const handleDownload = async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/files/download`, {
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
    a.click();
    URL.revokeObjectURL(url);
  };

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
          fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(p)}`, {
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

  return { tree, fetchTree, handleDownload, handleDelete, deleteError };
}
