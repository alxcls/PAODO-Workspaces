// Disk-backed registry of per-workspace agent schedules — one schedule per workspace.
// A schedule fires the workspace's agent on a fixed interval ("every N minutes/hours/days/weeks")
// with a configured prompt, in a chosen IANA timezone, optionally bounded by a start/end window.
//
// Stored as a sibling of the other app-level JSON files under WORKSPACES_ROOT (never inside a
// workspace directory or container, so it survives container recreation). Mirrors the shape and
// persistence pattern of apiKeyStore.ts.
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createLogger } from "../logger";

const log = createLogger("schedules");

const FILE = path.join(WORKSPACES_ROOT, ".cron-schedules.json");

export type IntervalUnit = "minute" | "hour" | "day" | "week";
export type RunStatus = "ok" | "error";

export interface ScheduleEntry {
  id: string;
  workspaceId: string;
  /** The message sent to the agent each run. */
  prompt: string;
  /** Recurrence: fire every `intervalValue` `intervalUnit`s (both taken from the start anchor). */
  intervalValue: number;
  intervalUnit: IntervalUnit;
  /** ISO-8601 start anchor. Interpreted in `timezone`; the first run is the first occurrence >= now. */
  startAt: string;
  /** Optional ISO-8601 end bound — no runs fire at or after this instant. */
  endAt?: string;
  /** IANA timezone (e.g. "Europe/Brussels") the start/recurrence wall-clock is interpreted in. */
  timezone: string;
  enabled: boolean;
  createdAt: string;
  /** Next scheduled fire instant (ISO), recomputed on create/update, on boot, and after each run. */
  nextRunAt: string | null;
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
  /** Short snippet of the last run's final response, for at-a-glance status in the UI. */
  lastRunSnippet?: string;
}

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
  // a workspace that never had a schedule. Matches mcpConfigStore/workspaceSecretStore.
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
