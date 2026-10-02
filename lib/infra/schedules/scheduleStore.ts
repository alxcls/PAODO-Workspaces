// Disk-backed registry of per-workspace schedules, storage only: it stores any well-typed entry, so the
// rules about what may be stored live in lib/operations/schedules/schedule.ts. Mirrors credentialStore.ts.
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createLogger } from "../logger";
import type { LastRun, RunStatus, ScheduleEntry } from "@/lib/schedules/types";

const log = createLogger("schedules");

// Beside the other app JSON files, never inside a workspace, so it survives container recreation.
const FILE = path.join(WORKSPACES_ROOT, ".cron-schedules.json");

type Store = Record<string, ScheduleEntry>;

/** A record as written before the last run's fields were grouped under `lastRun`. */
type LegacyEntry = ScheduleEntry & { lastRunAt?: string; lastRunStatus?: RunStatus; lastRunSnippet?: string };

/** Folds older records' flat last-run fields into `lastRun`, dropping the retired snippet. */
function upgradeLegacyEntries(loaded: Store): Store {
  for (const entry of Object.values(loaded) as LegacyEntry[]) {
    if (!entry.lastRun && entry.lastRunAt && entry.lastRunStatus) {
      entry.lastRun = { at: entry.lastRunAt, status: entry.lastRunStatus };
    }
    delete entry.lastRunAt;
    delete entry.lastRunStatus;
    delete entry.lastRunSnippet;
  }
  return loaded;
}

const store = globalSingleton<Store>("cronSchedules", () => upgradeLegacyEntries(readJson<Store>(FILE, {})));

function save(candidate: Store, context: { workspaceId: string; scheduleId: string; operation: string }) {
  try {
    atomicSaveJson(FILE, candidate);
    for (const key of Object.keys(store)) delete store[key];
    Object.assign(store, candidate);
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
  return store[workspaceId] ? structuredClone(store[workspaceId]) : null;
}

export function listAll(): ScheduleEntry[] {
  return structuredClone(Object.values(store));
}

export function setSchedule(entry: ScheduleEntry): void {
  save(
    { ...store, [entry.workspaceId]: structuredClone(entry) },
    { workspaceId: entry.workspaceId, scheduleId: entry.id, operation: "set_schedule" },
  );
  log.info({ workspaceId: entry.workspaceId, scheduleId: entry.id }, "schedule set");
}

/** Update a schedule's next-run pointer (called on boot and after each firing). */
export function setNextRunAt(workspaceId: string, nextRunAt: string | null): void {
  const entry = store[workspaceId];
  if (!entry) return;
  save(
    { ...store, [workspaceId]: { ...entry, nextRunAt } },
    { workspaceId, scheduleId: entry.id, operation: "set_next_run" },
  );
}

/**
 * Remove a workspace's schedule entirely. Called only from the workspace-deletion cascade — a
 * schedule must not outlive the workspace it fires. Disabling a schedule is a separate,
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
  const candidate = { ...store };
  delete candidate[workspaceId];
  save(candidate, { workspaceId, scheduleId, operation: "clear_schedule" });
  log.info({ workspaceId, scheduleId }, "schedule cleared");
}

/** Record the outcome of a run and advance the next-run pointer in one atomic write. */
export function recordRun(workspaceId: string, run: LastRun, nextRunAt: string | null): void {
  const entry = store[workspaceId];
  if (!entry) return;
  save(
    { ...store, [workspaceId]: { ...entry, lastRun: structuredClone(run), nextRunAt } },
    { workspaceId, scheduleId: entry.id, operation: "record_run" },
  );
  log.info({ workspaceId, status: run.status, nextRunAt }, "schedule run recorded");
}
