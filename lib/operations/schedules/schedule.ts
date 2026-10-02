// The workspace-schedule use case: the one entry point every trigger (modal, REST, CLI, MCP) reads and
// replaces a schedule through, so its validation and identity rules exist once rather than per transport.
import { randomUUID } from "crypto";
import { DateTime } from "luxon";
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import * as scheduleStore from "@/lib/infra/schedules/scheduleStore";
import { computeNextRun, endBound, isValidTimezone, nextRunIso } from "@/lib/schedules/nextRun";
import {
  INTERVAL_UNITS,
  MIN_INTERVAL_VALUE,
  MAX_INTERVAL_VALUE,
  type IntervalUnit,
  type ScheduleEntry,
} from "@/lib/schedules/types";
import { ScheduleInvalidError } from "./errors";

/**
 * A whole schedule as a caller supplies it — unvalidated. PUT semantics: this is a replace, not a
 * patch, so every field except `endAt` and `enabled` is required and an omission is a rejection
 * rather than "leave it alone". Field types state what a well-formed request claims; validateSchedule
 * checks them, because a JSON body only claims to match.
 */
export interface ScheduleInput {
  prompt?: string;
  intervalValue?: number;
  intervalUnit?: string;
  /** Null and absent both mean "no end bound". */
  endAt?: string | null;
  startAt?: string;
  timezone?: string;
  enabled?: boolean;
}

/** The same fields once checked and canonicalized: safe to build an entry from as-is. */
export interface ScheduleConfig {
  prompt: string;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  startAt: string;
  endAt?: string;
  timezone: string;
  enabled: boolean;
}

/** The persistence surface this operation needs, so a test can assert without touching disk. */
export type ScheduleReader = Pick<typeof scheduleStore, "getSchedule">;
export type ScheduleWriter = Pick<typeof scheduleStore, "getSchedule" | "setSchedule">;

/** Per-concern seams, each defaulting to the real system. Tests override only what they assert on. */
export interface SetScheduleDeps {
  schedules?: ScheduleWriter;
  workspaces?: Pick<IWorkspaceStore, "getWorkspace">;
  /** Injected so a test can assert the computed next-run instant rather than re-derive it. */
  now?: () => Date;
  /** Injected so a test can tell a preserved id from a freshly minted one. */
  newId?: () => string;
}

/** The wire names a schedule has. Any other is refused, since a replace would silently drop it. */
export const SCHEDULE_FIELDS = [
  "prompt",
  "intervalValue",
  "intervalUnit",
  "startAt",
  "endAt",
  "timezone",
  "enabled",
] as const;

/** One rejected field, with the values it takes when they are a closed set. */
export interface ScheduleIssue {
  field: string;
  error: string;
  acceptedValues?: string[];
}

/** A Z or ±hh:mm after the time. computeNextRun would honour it over `timezone`, firing at another hour. */
const UTC_OFFSET = /T.*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function offsetMessage(field: "startAt" | "endAt", example: string): string {
  return `${field} must be a time on the timezone's clock, without Z or an offset, e.g. ${example}`;
}

/**
 * Checks and canonicalizes a whole schedule, touching nothing. Pure, so a caller can validate a
 * request before its first write, and so every message below is reachable from a unit test.
 *
 * Each rejection states the accepted values: a caller with no form constraining it — the CLI, a
 * script, an agent — otherwise gets "ok" back for a value we quietly replaced, or a 500 for one that
 * reached `.trim()` as a number. Every bad field is reported in one rejection, so fixing them takes
 * one round trip rather than one per field. `now` only decides whether an enabled schedule has a run left.
 */
export function validateSchedule(input: ScheduleInput, now: Date = new Date()): ScheduleConfig {
  const issues: ScheduleIssue[] = [];
  const reject = (field: string, error: string, acceptedValues?: readonly string[]) => {
    issues.push({ field, error, ...(acceptedValues ? { acceptedValues: [...acceptedValues] } : {}) });
  };
  // A present field that cannot be read as text is a caller error, not an omission — see metadata.ts.
  const text = (value: unknown, field: string): string | undefined => {
    if (typeof value === "string") return value;
    reject(field, `${field} must be a string`);
  };
  const missing = (value: unknown) =>
    value === undefined || value === null || (typeof value === "string" && !value.trim());

  for (const field of Object.keys(input)) {
    if (!(SCHEDULE_FIELDS as readonly string[]).includes(field)) {
      reject(field, `unknown field ${field}, accepted: ${SCHEDULE_FIELDS.join(", ")}`);
    }
  }

  // `enabled: "false"` is truthy, so coercing it would store a disabled schedule as enabled. Only an
  // explicit true enables, so an omitted or refused value never makes a schedule fire.
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    reject("enabled", "enabled must be true or false");
  const enabled = input.enabled === true;

  // An enabled schedule must have a prompt to fire; a disabled one may be saved as a draft without one.
  const prompt = text(input.prompt ?? "", "prompt")?.trim();
  if (enabled && prompt === "") reject("prompt", "prompt is required");

  const intervalValue = input.intervalValue;
  if (missing(intervalValue)) reject("intervalValue", "intervalValue is required");
  else if (
    !Number.isSafeInteger(intervalValue) ||
    (intervalValue as number) < MIN_INTERVAL_VALUE ||
    (intervalValue as number) > MAX_INTERVAL_VALUE
  ) {
    reject("intervalValue", `intervalValue must be an integer >= ${MIN_INTERVAL_VALUE} and <= ${MAX_INTERVAL_VALUE}`);
  }

  if (missing(input.intervalUnit)) reject("intervalUnit", "intervalUnit is required", INTERVAL_UNITS);
  else if (!INTERVAL_UNITS.includes(input.intervalUnit as IntervalUnit)) {
    reject("intervalUnit", `intervalUnit must be one of ${INTERVAL_UNITS.join(", ")}`, INTERVAL_UNITS);
  }

  const timezone = text(input.timezone ?? "", "timezone");
  if (timezone !== undefined) {
    if (missing(timezone)) reject("timezone", "timezone is required");
    else if (!isValidTimezone(timezone)) reject("timezone", "timezone must be a valid IANA timezone");
  }
  // Dates are read as the scheduler reads them; UTC stands in for a refused zone so they still get checked.
  const zone = timezone && isValidTimezone(timezone) ? timezone : "UTC";

  const startAt = text(input.startAt ?? "", "startAt");
  let validStart: string | undefined;
  if (startAt !== undefined) {
    if (missing(startAt)) reject("startAt", "startAt is required");
    else if (UTC_OFFSET.test(startAt)) reject("startAt", offsetMessage("startAt", "2026-10-02T09:00"));
    else if (!DateTime.fromISO(startAt, { zone }).isValid)
      reject("startAt", "startAt must be a valid date-time, e.g. 2026-10-02T09:00");
    else validStart = startAt;
  }

  // Null is how a caller clears an existing bound, so it is an accepted spelling of "absent" rather
  // than a wrong type. A blank string means the same thing.
  const endAt =
    input.endAt === undefined || input.endAt === null ? undefined : text(input.endAt, "endAt")?.trim() || undefined;
  if (endAt) {
    const end = endBound({ endAt, timezone: zone });
    if (UTC_OFFSET.test(endAt)) reject("endAt", offsetMessage("endAt", "2026-10-31T18:00"));
    else if (!end) reject("endAt", "endAt must be a valid date, e.g. 2026-10-31 or 2026-10-31T18:00");
    else if (validStart && end <= DateTime.fromISO(validStart, { zone }))
      reject("endAt", "endAt must be after startAt");
  }

  if (issues.length > 0) throw invalid(issues);

  const config: ScheduleConfig = {
    prompt: prompt as string,
    intervalValue: intervalValue as number,
    intervalUnit: input.intervalUnit as IntervalUnit,
    startAt: validStart as string,
    ...(endAt ? { endAt } : {}),
    timezone: timezone as string,
    enabled,
  };

  // Checked last, since whether a run is left depends on every other field being valid.
  if (enabled && !computeNextRun(config, now)) {
    if (!config.endAt) {
      reject("intervalValue", "schedule has no representable future run; reduce intervalValue or move startAt");
      throw invalid(issues);
    }
    reject(
      "endAt",
      "endAt leaves no run after now, so an enabled schedule would never fire; move or clear endAt, or save it disabled",
    );
    throw invalid(issues);
  }
  return config;
}

function invalid(issues: ScheduleIssue[]): ScheduleInvalidError {
  return new ScheduleInvalidError(issues.map((issue) => issue.error).join("; "), { issues });
}

/** A workspace's schedule, or null when it has none. */
export function getWorkspaceSchedule(id: string, schedules: ScheduleReader = scheduleStore): ScheduleEntry | null {
  return schedules.getSchedule(id);
}

/**
 * Replaces a workspace's schedule, or creates it. Returns null when the workspace does not exist, so
 * adapters can translate that into their native not-found result — the check belongs here because a
 * schedule must never outlive or precede the workspace it fires (lib/infra/workspaceDeleteDeps.ts
 * clears it from the other end).
 *
 * A replace keeps the schedule's IDENTITY and its HISTORY. Only the configuration is caller-owned:
 * the id, the creation time and the last run carry over, because editing the prompt or the
 * interval does not make this a different schedule and must not erase what it has already done. That
 * rule is the reason this function exists rather than a bare `setSchedule` call.
 */
export function setWorkspaceSchedule(
  id: string,
  input: ScheduleInput,
  deps: SetScheduleDeps = {},
): ScheduleEntry | null {
  const schedules = deps.schedules ?? scheduleStore;
  const workspaces = deps.workspaces ?? getStore();
  if (!workspaces.getWorkspace(id)) return null;

  // Validate the whole request before the single write, so a bad field changes nothing at all.
  const now = (deps.now ?? (() => new Date()))();
  const config = validateSchedule(input, now);
  const existing = schedules.getSchedule(id);

  const entry: ScheduleEntry = {
    ...config,
    id: existing?.id ?? (deps.newId ?? randomUUID)(),
    workspaceId: id,
    createdAt: existing?.createdAt ?? now.toISOString(),
    // Null when disabled: the tick loop reads this pointer, so leaving one set would fire it anyway.
    nextRunAt: nextRunIso(config, now),
    ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}),
  };

  schedules.setSchedule(entry);
  return entry;
}

/** Merge and commit synchronously in the server process, so independent client edits survive. */
export function patchWorkspaceSchedule(
  id: string,
  changes: ScheduleInput,
  deps: SetScheduleDeps = {},
): ScheduleEntry | null {
  const existing = (deps.schedules ?? scheduleStore).getSchedule(id);
  const config = existing
    ? Object.fromEntries(SCHEDULE_FIELDS.filter((field) => field in existing).map((field) => [field, existing[field]]))
    : {};
  return setWorkspaceSchedule(id, { ...config, ...changes }, deps);
}
