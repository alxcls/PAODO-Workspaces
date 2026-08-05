// The recurring-agent-run entity, and the vocabulary its fields are drawn from.
//
// Deliberately dependency-free — no store, no logger, no luxon. A schedule is a thing the product
// has, not a thing the disk has, so the record shape must be nameable without pulling persistence
// into the importer's graph. That is what lets the browser panel
// (components/workspace/SchedulePanel.tsx) type its fetch result from the same declaration the
// scheduler fires from, instead of re-declaring a copy that drifts.
//
// Behaviour that reads these fields lives in ./nextRun.ts (recurrence math) and
// lib/operations/schedules/schedule.ts (what a caller may set). Persistence is
// lib/infra/schedules/scheduleStore.ts.

/** Recurrence step. Also exported as a runtime list, so validators and the type cannot drift. */
export const INTERVAL_UNITS = ["minute", "hour", "day", "week"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export type RunStatus = "ok" | "error";

/** The smallest recurrence a schedule may declare. */
export const MIN_INTERVAL_VALUE = 1;

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
