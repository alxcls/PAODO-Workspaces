// Loads the workspace registry for the home page and owns every mutation against it (create /
// rename / delete), re-reading the list after each so the sidebar reflects the server's ordering
// rather than a locally patched copy.
//
// Mutations resolve to a MutationResult instead of throwing: a rejected name (duplicate, invalid)
// is a normal outcome the caller renders inline next to the input, not an error boundary case.
// Naming policy stays with the caller — `create` persists exactly the name it is given.
"use client";

import { useState, useEffect, useCallback } from "react";
import { readApiError, type MutationResult } from "@/lib/client/apiError";

export interface WorkspaceItem {
  id: string;
  name: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/workspaces");
    if (res.ok) setWorkspaces((await res.json()) as WorkspaceItem[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces")
      .then(async (res) => {
        if (!res.ok) return;
        const items = (await res.json()) as WorkspaceItem[];
        if (!cancelled) setWorkspaces(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const create = useCallback(
    async (name: string): Promise<{ ok: true; workspace: WorkspaceItem } | { ok: false; error: string }> => {
      setIsCreating(true);
      try {
        const res = await fetch("/api/workspaces", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name }),
        });
        if (!res.ok) return readApiError(res, "Failed to create workspace.");
        const workspace = (await res.json()) as WorkspaceItem;
        await refresh();
        return { ok: true, workspace };
      } finally {
        setIsCreating(false);
      }
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<MutationResult> => {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return readApiError(res, "Failed to rename workspace.");
      await refresh();
      return { ok: true };
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
      await refresh();
    },
    [refresh],
  );

  return { workspaces, isCreating, refresh, create, rename, remove };
}
