// Fetches a workspace's durable disk usage from GET /api/workspaces/:id/storage when the id changes.
//
// Same shape as useWorkspaceMeta: null until loaded and for a null id, and the loaded id is paired
// with the result so switching workspaces never shows the previous one's size while the next loads.
"use client";

import { useEffect, useState } from "react";

export interface WorkspaceStorage {
  workspaceId: string;
  bytes: number;
  breakdown: { workspace: number; home: number; versioning: number };
}

export function useWorkspaceStorage(workspaceId: string | null): WorkspaceStorage | null {
  const [loaded, setLoaded] = useState<{ id: string; usage: WorkspaceStorage } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/storage`, { cache: "no-store" });
        if (!response.ok) return;
        const usage = (await response.json()) as WorkspaceStorage;
        if (active) setLoaded({ id: workspaceId, usage });
      } catch {
        /* leave it unloaded — the caller renders nothing */
      }
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return loaded && loaded.id === workspaceId ? loaded.usage : null;
}
