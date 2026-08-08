// Disk-backed registry of per-workspace agent schedules — one schedule per workspace.
//
// STORAGE ONLY. The record shape is lib/schedules/types.ts and the rules about what may be stored
// are lib/operations/schedules/schedule.ts; this file knows where the bytes go and nothing about
// what they mean. It accepts any well-typed entry, so reaching it without going through the
// operation stores an entry no validator has seen.
//
// Stored as a sibling of the other app-level JSON files under WORKSPACES_ROOT (never inside a
// workspace directory or container, so it survives container recreation). Mirrors the shape and
// persistence pattern of credentialStore.ts.
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createLogger } from "../logger";
import type { RunStatus, ScheduleEntry } from "@/lib/schedules/types";

const log = createLogger("schedules");

const FILE = path.join(WORKSPACES_ROOT, ".cron-schedules.json");

type Store = Record<string, ScheduleEntry>;

const store = globalSingleton<Store>("cronSchedules", () => readJson<Store>(FILE, {}));

function save(context: { workspaceId: string; scheduleId: string; operation: string }) {
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error(
      {
        event: "schedule_store_save_failed",
        outcome: "schedule_state_not_persisted",
        err,
        filePath: FILE,
        ...context,
      },
      "failed to save schedule store",
    );
    throw err;
  }
}

export function getSchedule(workspaceId: string): ScheduleEntry | null {
  return store[workspaceId] ?? null;
}

export function listAll(): ScheduleEntry[] {
  return Object.values(store);
}

export function setSchedule(entry: ScheduleEntry): void {
  store[entry.workspaceId] = entry;
  save({ workspaceId: entry.workspaceId, scheduleId: entry.id, operation: "set_schedule" });
  log.info({ workspaceId: entry.workspaceId, scheduleId: entry.id }, "schedule set");
}

/** Update a schedule's next-run pointer (called on boot and after each firing). */
export function setNextRunAt(workspaceId: string, nextRunAt: string | null): void {
  const entry = store[workspaceId];
  if (!entry) return;
  entry.nextRunAt = nextRunAt;
  save({ workspaceId, scheduleId: entry.id, operation: "set_next_run" });
}

/**
 * Remove a workspace's schedule entirely. Called only from the workspace-deletion cascade — a
 * schedule must not outlive the workspace it fires. Turning a schedule off is a separate,
 * non-destructive operation (setSchedule with enabled: false), so this is deliberately not
 * reachable over HTTP.
 */
export function clearSchedule(workspaceId: string): void {
  const entry = store[workspaceId];
  // No-op when absent: avoids a pointless disk write and log line for the common case of deleting
  // a workspace that never had a schedule. Matches credentialStore/workspaceSecretStore.
  if (!entry) return;
  // Read the id before deleting — save()'s context requires it.
  const scheduleId = entry.id;
  delete store[workspaceId];
  save({ workspaceId, scheduleId, operation: "clear_schedule" });
  log.info({ workspaceId, scheduleId }, "schedule cleared");
}

/** Record the outcome of a run and advance the next-run pointer in one atomic write. */
export function recordRun(
  workspaceId: string,
  outcome: { at: string; status: RunStatus; snippet: string; nextRunAt: string | null },
): void {
  const entry = store[workspaceId];
  if (!entry) return;
  entry.lastRunAt = outcome.at;
  entry.lastRunStatus = outcome.status;
  entry.lastRunSnippet = outcome.snippet;
  entry.nextRunAt = outcome.nextRunAt;
  save({ workspaceId, scheduleId: entry.id, operation: "record_run" });
  log.info({ workspaceId, status: outcome.status, nextRunAt: outcome.nextRunAt }, "schedule run recorded");
}
