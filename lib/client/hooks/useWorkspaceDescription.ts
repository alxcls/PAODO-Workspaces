// Loads and persists a workspace's description. Reads as empty on every workspace switch (and when
// nothing is selected) so the previous workspace's text never renders under a new heading.
// A failed load is swallowed to empty — the editor opens blank rather than blocking the page.
"use client";

import { useState, useEffect, useCallback } from "react";
import { confirmedValues } from "@/lib/client/workspaceReceipt";

export function useWorkspaceDescription(workspaceId: string | null) {
  const [loaded, setLoaded] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}`)
      .then((r) => r.json())
      .then((ws: { description?: string }) => {
        if (!cancelled) setLoaded({ id: workspaceId, text: ws.description ?? "" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: workspaceId, text: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Tagged with the workspace it was loaded for, so text from the previous selection is a derived
  // miss rather than a reset write in the effect body (same shape as useWorkspaceMeta).
  const description = loaded && loaded.id === workspaceId ? loaded.text : "";

  // Optimistic: the new value renders immediately and is rolled back to the prior one if the PATCH
  // fails, so a rejected save never leaves the editor showing text the server didn't keep.
  const save = useCallback(
    async (next: string) => {
      if (!workspaceId) return;
      const previous = description;
      setLoaded({ id: workspaceId, text: next.trim() });
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: next }),
      });
      if (!res.ok) {
        setLoaded({ id: workspaceId, text: previous });
        return;
      }
      const { description: confirmed } = await confirmedValues(res);
      setLoaded({ id: workspaceId, text: confirmed ?? next.trim() });
    },
    [workspaceId, description],
  );

  return { description, save };
}
