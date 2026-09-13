"use client";

import { useCallback } from "react";
import type { WorkspaceDetails as ServerWorkspaceDetails } from "@/lib/operations/workspace/read";
import { fetchJson } from "@/lib/client/fetchJson";
import { useAsyncResource } from "./useAsyncResource";

/** JSON representation of the server-owned workspace projection. */
export type WorkspaceDetails = Omit<ServerWorkspaceDetails, "createdAt"> & { createdAt: string };

/** Load once in the page; metadata, description, model and limits share this result and retry. */
export function useWorkspaceDetails(workspaceId: string | null) {
  return useAsyncResource<WorkspaceDetails>(
    useCallback(
      (signal) =>
        fetchJson<WorkspaceDetails>(`/api/workspaces/${workspaceId}`, signal, "Failed to load workspace details."),
      [workspaceId],
    ),
    { enabled: workspaceId !== null },
  );
}
