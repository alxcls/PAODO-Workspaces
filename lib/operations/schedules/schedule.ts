// The workspace-schedule use case: one trigger-neutral entry point for reading and replacing a
// workspace's single recurring agent run — the settings modal, the REST route, the CLI, a later MCP
// adapter — so the rules and their messages exist once instead of once per transport.
//
// Before this module the rules lived inline in the PUT handler, which meant a caller that was not an
// HTTP request could not reach them at all: the six validation blocks AND the identity rule below
// (a replace keeps the schedule's id, its creation time and its run history) were only executed by
// the route. A second trigger would have had to restate them, and the first divergence would be
// invisible — two callers disagreeing about what a schedule is.
//
// Read/write both live here rather than in read.ts + set.ts: schedules are one capability with one
// record, and a three-line read module would be filing without dividing. Split when a projection or
// a second query earns it.
import { randomUUID } from "crypto";
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import * as scheduleStore from "@/lib/infra/schedules/scheduleStore";
import { computeNextRun, isValidTimezone } from "@/lib/schedules/nextRun";
import { INTERVAL_UNITS, MIN_INTERVAL_VALUE, type IntervalUnit, type ScheduleEntry } from "@/lib/schedules/types";
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

/** A present field that cannot be read as text is a caller error, not an omission — see metadata.ts. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ScheduleInvalidError(`${field} must be a string`, { field });
  return value;
}

/**
 * Checks and canonicalizes a whole schedule, touching nothing. Pure, so a caller can validate a
 * request before its first write, and so every message below is reachable from a unit test.
 *
 * Each rejection states the accepted values: a caller with no form constraining it — the CLI, a
 * script, an agent — otherwise gets "ok" back for a value we quietly replaced, or a 500 for one that
 * reached `.trim()` as a number.
 */
export function validateSchedule(input: ScheduleInput): ScheduleConfig {
  const prompt = requireString(input.prompt ?? "", "prompt").trim();
  if (!prompt) throw new ScheduleInvalidError("prompt is required", { field: "prompt" });

  const intervalValue = input.intervalValue;
  if (!Number.isInteger(intervalValue) || (intervalValue as number) < MIN_INTERVAL_VALUE) {
    throw new ScheduleInvalidError(`intervalValue must be an integer >= ${MIN_INTERVAL_VALUE}`, {
      field: "intervalValue",
    });
  }

  if (!INTERVAL_UNITS.includes(input.intervalUnit as IntervalUnit)) {
    throw new ScheduleInvalidError(`intervalUnit must be one of ${INTERVAL_UNITS.join(", ")}`, {
      field: "intervalUnit",
      acceptedValues: [...INTERVAL_UNITS],
    });
  }

  // Checked before startAt is read: the anchor is a wall-clock time that only means something once
  // the zone it is interpreted in is known to exist.
  const timezone = requireString(input.timezone ?? "", "timezone");
  if (!timezone || !isValidTimezone(timezone)) {
    throw new ScheduleInvalidError("timezone must be a valid IANA timezone", { field: "timezone" });
  }

  const startAt = requireString(input.startAt ?? "", "startAt");
  if (!startAt || Number.isNaN(Date.parse(startAt))) {
    throw new ScheduleInvalidError("startAt must be a valid date-time", { field: "startAt" });
  }

  // Null is how a caller clears an existing bound, so it is an accepted spelling of "absent" rather
  // than a wrong type. A blank string means the same thing.
  let endAt: string | undefined;
  if (input.endAt !== undefined && input.endAt !== null) {
    endAt = requireString(input.endAt, "endAt").trim() || undefined;
    if (endAt) {
      if (Number.isNaN(Date.parse(endAt))) {
        throw new ScheduleInvalidError("endAt must be a valid date", { field: "endAt" });
      }
      if (Date.parse(endAt) <= Date.parse(startAt)) {
        throw new ScheduleInvalidError("endAt must be after startAt", { field: "endAt" });
      }
    }
  }

  // Defaults to on: creating a schedule and leaving it paused is not what a caller asked for. Checked
  // for type because `enabled: "false"` is truthy — coercing it would store a paused schedule as live,
  // and store a non-boolean in the file besides.
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ScheduleInvalidError("enabled must be a boolean", { field: "enabled" });
  }

  return {
    prompt,
    intervalValue: intervalValue as number,
    intervalUnit: input.intervalUnit as IntervalUnit,
    startAt,
    ...(endAt ? { endAt } : {}),
    timezone,
    enabled: input.enabled ?? true,
  };
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
 * the id, the creation time and the last-run fields carry over, because editing the prompt or the
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
  const config = validateSchedule(input);
  const existing = schedules.getSchedule(id);
  const now = (deps.now ?? (() => new Date()))();

  // A disabled schedule has no next run — the pointer is what the tick loop reads, so leaving one set
  // would fire a schedule the caller just paused.
  const next = config.enabled ? computeNextRun(config, now) : null;

  const entry: ScheduleEntry = {
    ...config,
    id: existing?.id ?? (deps.newId ?? randomUUID)(),
    workspaceId: id,
    createdAt: existing?.createdAt ?? now.toISOString(),
    nextRunAt: next ? next.toISOString() : null,
    ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
    ...(existing?.lastRunStatus !== undefined ? { lastRunStatus: existing.lastRunStatus } : {}),
    ...(existing?.lastRunSnippet !== undefined ? { lastRunSnippet: existing.lastRunSnippet } : {}),
  };

  schedules.setSchedule(entry);
  return entry;
}
