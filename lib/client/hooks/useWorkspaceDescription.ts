// Edits the description from the page’s shared workspace read, with optimistic save/rollback.
"use client";

import { useState, useCallback } from "react";
import { confirmedValues } from "@/lib/client/workspaceReceipt";
import type { AsyncResource } from "./useAsyncResource";
import type { WorkspaceDetails } from "./useWorkspaceDetails";

export function useWorkspaceDescription(workspaceId: string | null, resource: AsyncResource<WorkspaceDetails>) {
  // Local edits, tagged with the workspace they belong to so a leftover override from the previous
  // selection is a derived miss rather than a value that bleeds across a switch.
  const [override, setOverride] = useState<{ id: string; text: string; source: WorkspaceDetails | null } | null>(null);
  const serverText = resource.data?.description ?? "";
  const description =
    override && override.id === workspaceId && override.source === resource.data ? override.text : serverText;

  // Optimistic: the new value renders immediately and is rolled back to the prior one if the PATCH
  // fails, so a rejected save never leaves the editor showing text the server didn't keep.
  const save = useCallback(
    async (next: string) => {
      if (!workspaceId) return;
      const previous = description;
      setOverride({ id: workspaceId, text: next.trim(), source: resource.data });
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: next }),
        });
        if (!res.ok) {
          setOverride({ id: workspaceId, text: previous, source: resource.data });
          return;
        }
        const { description: confirmed } = await confirmedValues(res);
        setOverride({ id: workspaceId, text: confirmed ?? next.trim(), source: resource.data });
      } catch {
        setOverride({ id: workspaceId, text: previous, source: resource.data });
      }
    },
    [workspaceId, description, resource.data],
  );

  return { description, loading: resource.loading, error: resource.error, reload: resource.reload, save };
}
