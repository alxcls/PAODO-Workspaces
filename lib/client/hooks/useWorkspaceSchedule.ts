"use client";

import { useCallback, useEffect } from "react";
import { fetchJson } from "@/lib/client/fetchJson";
import type { PresentedSchedule, ScheduleEntry, UnsetSchedule } from "@/lib/schedules/types";
import { useAsyncResource, type AsyncResource } from "./useAsyncResource";

/** `entry` is null for the unset job, wrapped so that reads apart from a read still in flight. */
export interface ScheduleData {
  entry: PresentedSchedule | null;
}

/** The configuration fields a PATCH may update; the server keeps the id, the timestamps and the last run. */
export type SchedulePayload = Pick<
  ScheduleEntry,
  "prompt" | "intervalValue" | "intervalUnit" | "startAt" | "timezone" | "enabled"
> & { endAt: string | null };

export interface WorkspaceSchedule extends AsyncResource<ScheduleData> {
  /** Updates named fields, then re-reads the schedule. */
  save: (payload: Partial<SchedulePayload>) => Promise<void>;
}

/**
 * Reads and replaces a workspace's single schedule. While `pollMs` is set it re-reads at once and then
 * on that interval (skipped while the tab is hidden), so a finished run or a CLI edit shows up.
 */
export function useWorkspaceSchedule(workspaceId: string, { pollMs }: { pollMs?: number } = {}): WorkspaceSchedule {
  const url = `/api/workspaces/${workspaceId}/schedule`;
  const resource = useAsyncResource<ScheduleData>(
    useCallback(
      async (signal: AbortSignal) => {
        const job = await fetchJson<PresentedSchedule | UnsetSchedule>(url, signal, "Failed to load schedule.");
        // Only a saved job has an id. The form fills an unset one from the browser's clock and timezone.
        return { entry: "id" in job ? job : null };
      },
      [url],
    ),
  );

  const { reload } = resource;
  useEffect(() => {
    if (!pollMs) return;
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, reload]);

  const save = useCallback(
    async (payload: Partial<SchedulePayload>) => {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      await reload();
    },
    [url, reload],
  );

  return { ...resource, save };
}
