/**
 * Fetches a workspace's durable disk usage from GET /api/workspaces/:id/storage when the id changes.
 *
 * The disk walk behind this route is the slowest of the home page's fetches, so it returns the shared
 * async-resource shape ({ data, loading, error, reload }) and the caller shows a spinner + retry
 * rather than a blank line. useAsyncResource's stale guard keeps a slow request for the previous
 * workspace from landing on the next one, and enabled:false holds it idle when nothing is selected.
 */
"use client";

import { useCallback } from "react";
import { fetchJson } from "@/lib/client/fetchJson";
import { useAsyncResource, type AsyncResource } from "./useAsyncResource";

export interface WorkspaceStorage {
  workspaceId: string;
  bytes: number;
  breakdown: { workspace: number; home: number; versioning: number };
}

export function useWorkspaceStorage(workspaceId: string | null): AsyncResource<WorkspaceStorage> {
  return useAsyncResource<WorkspaceStorage>(
    useCallback(
      (signal) =>
        fetchJson<WorkspaceStorage>(`/api/workspaces/${workspaceId}/storage`, signal, "Failed to load storage usage.", {
          cache: "no-store",
        }),
      [workspaceId],
    ),
    { enabled: workspaceId !== null },
  );
}
