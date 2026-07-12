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

function save() {
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error({ err }, "failed to save schedule store");
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
  save();
  log.info({ workspaceId: entry.workspaceId, scheduleId: entry.id }, "schedule set");
}

export function deleteSchedule(workspaceId: string): void {
  if (!(workspaceId in store)) return;
  delete store[workspaceId];
  save();
  log.info({ workspaceId }, "schedule deleted");
}

/** Update a schedule's next-run pointer (called on boot and after each firing). */
export function setNextRunAt(workspaceId: string, nextRunAt: string | null): void {
  const entry = store[workspaceId];
  if (!entry) return;
  entry.nextRunAt = nextRunAt;
  save();
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
  save();
  log.info({ workspaceId, status: outcome.status, nextRunAt: outcome.nextRunAt }, "schedule run recorded");
}
