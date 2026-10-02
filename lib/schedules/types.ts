// The recurring-agent-run entity, dependency-free so the browser types its reads from this declaration.
// Its luxon recurrence math (./nextRun.ts) is shared with the browser too, for the next-run preview.

/** Recurrence step. Also exported as a runtime list, so validators and the type cannot drift. */
export const INTERVAL_UNITS = ["minute", "hour", "day", "week"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export type RunStatus = "ok" | "error";

/** The smallest recurrence a schedule may declare. */
export const MIN_INTERVAL_VALUE = 1;
/** Bounded in every unit, including disabled drafts. */
export const MAX_INTERVAL_VALUE = 10_000;
/** Longest prompt a schedule may send; kept under the gateway's 128KB body cap for any text. */
export const MAX_PROMPT_LENGTH = 20_000;

/** One run's outcome. The next run replaces it whole, so its fields never describe two runs. */
export interface LastRun {
  at: string;
  status: RunStatus;
  /** The conversation the run ran in. Absent only when it failed before one existed. */
  conversationId?: string;
  /** Why the run failed — the same text its conversation shows. Absent when it succeeded. */
  error?: string;
}

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
  /** Absent until a first run is recorded. */
  lastRun?: LastRun;
}
