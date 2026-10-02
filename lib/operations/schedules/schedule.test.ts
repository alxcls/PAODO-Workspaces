// The schedule contract: every rejection message (the CLI's only documentation of accepted values) and
// the identity rule — a replace keeps the id, the creation time and the last run.
import { describe, expect, it } from "vitest";
import {
  setWorkspaceSchedule,
  patchWorkspaceSchedule,
  presentSchedule,
  validateSchedule,
  type ScheduleInput,
} from "./schedule";
import { AppError } from "@/lib/errors/appError";
import type { ScheduleEntry } from "@/lib/schedules/types";
import type { Workspace } from "@/lib/workspace/types";

const VALID: ScheduleInput = {
  prompt: "summarize yesterday's commits",
  intervalValue: 1,
  intervalUnit: "day",
  startAt: "2026-07-13T09:00",
  timezone: "UTC",
};

const workspace: Workspace = {
  id: "ws-1",
  name: "Alpha",
  dir: "/private/alpha",
  createdAt: new Date("2026-01-02T03:04:05Z"),
  description: "First workspace",
  maxIterations: 30,
  maxRunMinutes: 20,
  internetAccess: false,
};

const workspaces = { getWorkspace: (id: string) => (id === workspace.id ? workspace : undefined) };

/** In-memory stand-in for the JSON store, recording every write so a test can assert none happened. */
function fakeSchedules(initial: ScheduleEntry | null = null) {
  let current = initial;
  const writes: ScheduleEntry[] = [];
  return {
    writes,
    getSchedule: () => current,
    setSchedule: (entry: ScheduleEntry) => {
      current = entry;
      writes.push(entry);
    },
  };
}

// One hour before the start anchor, so the first occurrence is the anchor itself.
const NOW = new Date("2026-07-13T08:00:00Z");
const deps = (schedules: ReturnType<typeof fakeSchedules>) => ({
  schedules,
  workspaces,
  now: () => NOW,
  newId: () => "generated-id",
});

const stored: ScheduleEntry = {
  id: "existing-id",
  workspaceId: "ws-1",
  prompt: "the old prompt",
  intervalValue: 2,
  intervalUnit: "hour",
  startAt: "2026-07-01T09:00",
  timezone: "UTC",
  enabled: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  nextRunAt: "2026-07-13T09:00:00.000Z",
  lastRun: { at: "2026-07-12T09:00:00.000Z", status: "ok", conversationId: "conv-1" },
};

describe("schedule validation", () => {
  it("canonicalizes the values it accepts", () => {
    expect(validateSchedule({ ...VALID, prompt: "  padded  ", endAt: "2026-08-01T00:00", enabled: true }, NOW)).toEqual({
      prompt: "padded",
      intervalValue: 1,
      intervalUnit: "day",
      startAt: "2026-07-13T09:00",
      endAt: "2026-08-01T00:00",
      timezone: "UTC",
      enabled: true,
    });
  });

  // A schedule must never start firing from an omitted field, so an absent `enabled` means disabled.
  it("defaults enabled to false and treats a blank or null end bound as absent", () => {
    expect(validateSchedule(VALID).enabled).toBe(false);
    expect(validateSchedule({ ...VALID, enabled: true }).enabled).toBe(true);
    expect(validateSchedule({ ...VALID, endAt: null })).not.toHaveProperty("endAt");
    expect(validateSchedule({ ...VALID, endAt: "   " })).not.toHaveProperty("endAt");
  });

  // A disabled schedule is a draft: it never fires, so an empty prompt is allowed and only becomes
  // required once the schedule is enabled.
  it("requires a prompt only when the schedule is enabled", () => {
    expect(validateSchedule({ ...VALID, prompt: "  ", enabled: false }).prompt).toBe("");
    expect(() => validateSchedule({ ...VALID, prompt: "  ", enabled: true })).toThrow("prompt is required");
  });

  // These messages are the whole contract for a caller with no form to validate against, so their
  // content is asserted rather than just the fact that something threw.
  it("names what it accepts on every rejection", () => {
    expect(() => validateSchedule({ ...VALID, prompt: "   ", enabled: true })).toThrow("prompt is required");
    expect(() => validateSchedule({ ...VALID, intervalValue: 0 })).toThrow("intervalValue must be an integer >= 1");
    expect(() => validateSchedule({ ...VALID, intervalValue: 1.5 })).toThrow("intervalValue must be an integer >= 1");
    expect(() => validateSchedule({ ...VALID, intervalUnit: "fortnight" })).toThrow(
      "intervalUnit must be one of minute, hour, day, week",
    );
    expect(() => validateSchedule({ ...VALID, timezone: "Mars/Phobos" })).toThrow(
      "timezone must be a standard timezone name, e.g. Europe/Paris",
    );
    expect(() => validateSchedule({ ...VALID, startAt: "not-a-date" })).toThrow("startAt must be a valid date-time");
    // Date.parse reads a space separator, the scheduler does not: such a start would never fire.
    expect(() => validateSchedule({ ...VALID, startAt: "2026-07-13 09:00" })).toThrow(
      "startAt must be a valid date-time, e.g. 2026-10-02T09:00",
    );
    expect(() => validateSchedule({ ...VALID, endAt: "not-a-date" })).toThrow("endAt must be a valid date");
    expect(() => validateSchedule({ ...VALID, endAt: "2026-07-01T09:00" })).toThrow("endAt must be after startAt");
    expect(() => validateSchedule({ ...VALID, enabled: "TRUE" as never })).toThrow("enabled must be true or false");
  });

  it("names a missing field as required, whether absent, null or blank", () => {
    for (const field of ["intervalValue", "intervalUnit", "startAt", "timezone"] as const) {
      for (const value of [undefined, null, "  "]) {
        expect(() => validateSchedule({ ...VALID, [field]: value } as ScheduleInput)).toThrow(`${field} is required`);
      }
    }
    // A required unit still lists the units, so the one rejection is enough to fill it in.
    let error: unknown;
    try {
      validateSchedule({ ...VALID, intervalUnit: undefined });
    } catch (caught) {
      error = caught;
    }
    expect((error as AppError).details?.issues).toEqual([
      { field: "intervalUnit", error: "intervalUnit is required", acceptedValues: ["minute", "hour", "day", "week"] },
    ]);
  });

  // A date alone would leave the hour to be invented, so the refusal names the value to send instead.
  it("refuses a date without a time, for the start and the end", () => {
    expect(() => validateSchedule({ ...VALID, startAt: "2026-07-13" })).toThrow(
      "startAt needs a time, e.g. 2026-10-02T09:00",
    );
    expect(() => validateSchedule({ ...VALID, endAt: "2026-07-31" })).toThrow(
      "endAt needs a time; to include all of 2026-07-31, write endAt=2026-08-01T00:00",
    );
    expect(() => validateSchedule({ ...VALID, endAt: "2026-W31-5" })).toThrow("to include all of 2026-07-31");
  });

  it("refuses an enabled schedule with no run left before its end, and saves it disabled", () => {
    const ended = { ...VALID, startAt: "2026-07-01T09:00", endAt: "2026-07-05T09:00" };
    expect(() => validateSchedule({ ...ended, enabled: true }, NOW)).toThrow("endAt leaves no run after now");
    expect(validateSchedule({ ...ended, enabled: false }, NOW).enabled).toBe(false);
    // Not yet past, but the next weekly slot (07-13 09:00) falls after it.
    const weekly = {
      ...VALID,
      startAt: "2026-07-06T09:00",
      intervalUnit: "week",
      endAt: "2026-07-13T08:30",
      enabled: true,
    };
    expect(() => validateSchedule(weekly, NOW)).toThrow("endAt leaves no run after now");
  });

  // Stopping at the first bad field cost a caller one round trip per mistake to find the rest.
  it("reports every bad field in one rejection", () => {
    const input = {
      ...VALID,
      intervalValue: 0,
      intervalUnit: "month",
      timezone: "Mars/Base",
      enabld: true,
    } as ScheduleInput;
    let error: unknown;
    try {
      validateSchedule(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    const { message, code, details } = error as AppError;
    expect(code).toBe("SCHEDULE_INVALID");
    expect(message).toBe(
      "unknown field enabld, accepted: prompt, intervalValue, intervalUnit, startAt, endAt, timezone, enabled; " +
        "intervalValue must be an integer >= 1 and <= 10000; intervalUnit must be one of minute, hour, day, week; " +
        "timezone must be a standard timezone name, e.g. Europe/Paris",
    );
    expect(details).toEqual({
      issues: [
        { field: "enabld", error: expect.stringContaining("unknown field enabld") },
        { field: "intervalValue", error: "intervalValue must be an integer >= 1 and <= 10000" },
        {
          field: "intervalUnit",
          error: "intervalUnit must be one of minute, hour, day, week",
          acceptedValues: ["minute", "hour", "day", "week"],
        },
        { field: "timezone", error: "timezone must be a standard timezone name, e.g. Europe/Paris" },
      ],
    });
  });

  it("names a field once, and skips the rules a refused field would have gated", () => {
    const fieldsOf = (input: ScheduleInput) => {
      try {
        validateSchedule(input);
      } catch (error) {
        return ((error as AppError).details?.issues as { field: string }[]).map((issue) => issue.field);
      }
    };
    // A non-string timezone is not also "an invalid IANA timezone"; an invalid enabled does not require a prompt.
    expect(fieldsOf({ ...VALID, timezone: 5 as never })).toEqual(["timezone"]);
    expect(fieldsOf({ ...VALID, prompt: "", enabled: "true" as never })).toEqual(["enabled"]);
    // endAt is only compared against a startAt that is itself valid.
    expect(fieldsOf({ ...VALID, startAt: "not-a-date", endAt: "2026-07-01T09:00" })).toEqual(["startAt"]);
  });

  it("refuses a Z or offset that would override the timezone", () => {
    for (const startAt of [
      "2026-07-13T09:00Z",
      "2026-07-13T09:00:00.000z",
      "2026-07-13T09:00+05:00",
      "2026-07-13T09:00-0500",
    ]) {
      expect(() => validateSchedule({ ...VALID, startAt })).toThrow(
        "startAt must be a time on the timezone's clock, without Z or an offset, e.g. 2026-10-02T09:00",
      );
    }
    expect(() => validateSchedule({ ...VALID, endAt: "2026-08-01T18:00Z" })).toThrow(
      "endAt must be a time on the timezone's clock, without Z or an offset, e.g. 2026-10-31T18:00",
    );
    expect(validateSchedule({ ...VALID, endAt: "2026-08-01T18:00" }).endAt).toBe("2026-08-01T18:00");
  });

  it("rejects a request that omits a required field rather than inventing a default", () => {
    for (const field of ["prompt", "intervalValue", "intervalUnit", "startAt", "timezone"] as const) {
      // enabled: true so the prompt rule is in force — a disabled schedule accepts an omitted prompt.
      const partial: ScheduleInput = { ...VALID, enabled: true };
      delete partial[field];
      expect(() => validateSchedule(partial)).toThrow(AppError);
    }
  });

  /**
   * The declared input types bind in-process callers; a JSON body only claims to match them. Without
   * these guards `prompt: 5` reached `.trim()` as a number and left this layer as a TypeError — an
   * opaque 500 rather than the named rejection every other bad value gets — and `enabled: "false"`
   * was truthy, so it stored a disabled schedule as enabled and put a non-boolean in the file besides.
   */
  it("refuses a wrong-typed value instead of coercing or crashing on it", () => {
    const cases: ScheduleInput[] = [
      { ...VALID, prompt: 5 as never },
      { ...VALID, startAt: 5 as never },
      { ...VALID, timezone: 5 as never },
      { ...VALID, endAt: 5 as never },
      { ...VALID, enabled: "false" as never },
    ];
    for (const input of cases) {
      expect(() => validateSchedule(input)).toThrow(AppError);
    }
  });
});

describe("setting a workspace schedule", () => {
  it("mints an identity and computes the first run for a new schedule", () => {
    const schedules = fakeSchedules();
    const entry = setWorkspaceSchedule("ws-1", { ...VALID, enabled: true }, deps(schedules));

    expect(entry).toMatchObject({
      id: "generated-id",
      workspaceId: "ws-1",
      prompt: "summarize yesterday's commits",
      createdAt: NOW.toISOString(),
      // The start anchor itself, since it is still in the future at NOW.
      nextRunAt: "2026-07-13T09:00Z",
    });
    expect(schedules.writes).toHaveLength(1);
  });

  // The reason this function exists rather than a bare setSchedule call.
  it("keeps the id, the creation time and the run history when the configuration is replaced", () => {
    const schedules = fakeSchedules(stored);
    const entry = setWorkspaceSchedule("ws-1", { ...VALID, prompt: "a new prompt" }, deps(schedules));

    expect(entry).toMatchObject({
      id: "existing-id",
      createdAt: "2026-07-01T00:00:00.000Z",
      lastRun: { at: "2026-07-12T09:00:00.000Z", status: "ok", conversationId: "conv-1" },
      // Recomputed from the new configuration, not carried over.
      prompt: "a new prompt",
      intervalUnit: "day",
    });
  });

  // The pointer is what the tick loop reads, so leaving one set would fire a schedule just disabled.
  it("clears the next-run pointer when the schedule is disabled", () => {
    const schedules = fakeSchedules(stored);
    expect(setWorkspaceSchedule("ws-1", { ...VALID, enabled: false }, deps(schedules))?.nextRunAt).toBeNull();
  });

  it("returns null for an unknown workspace without writing anything", () => {
    const schedules = fakeSchedules();
    expect(setWorkspaceSchedule("missing", VALID, deps(schedules))).toBeNull();
    expect(schedules.writes).toEqual([]);
  });

  // Validate-before-write is the contract, not an implementation detail: a request carrying one bad
  // field must leave the stored schedule exactly as it was.
  it("leaves the stored schedule untouched when a field is invalid", () => {
    const schedules = fakeSchedules(stored);
    expect(() => setWorkspaceSchedule("ws-1", { ...VALID, timezone: "Mars/Phobos" }, deps(schedules))).toThrow(
      AppError,
    );
    expect(schedules.writes).toEqual([]);
    expect(schedules.getSchedule()).toEqual(stored);
  });

  it("judges whether a run is left against the injected clock", () => {
    const schedules = fakeSchedules();
    const input = { ...VALID, startAt: "2026-07-01T09:00", endAt: "2026-07-05T09:00", enabled: true };
    expect(() => setWorkspaceSchedule("ws-1", input, deps(schedules))).toThrow("endAt leaves no run after now");
    expect(schedules.writes).toEqual([]);
  });
});

describe("safe schedule updates", () => {
  it.each([1e300, 1e9, 1e12, 10001])("refuses an oversized interval %s even in a disabled draft", (intervalValue) => {
    for (const enabled of [false, true]) {
      expect(() => validateSchedule({ ...VALID, intervalValue, enabled }, NOW)).toThrow("<= 10000");
    }
  });

  it("keeps independent partial edits and server-owned history", () => {
    const schedules = fakeSchedules(stored);
    patchWorkspaceSchedule("ws-1", { prompt: "edited in UI" }, deps(schedules));
    const result = patchWorkspaceSchedule("ws-1", { intervalValue: 5 }, deps(schedules));
    expect(result).toMatchObject({ prompt: "edited in UI", intervalValue: 5, id: stored.id, lastRun: stored.lastRun });
  });

  it("creates through PATCH, clears an end bound, and rejects unknown fields without writing", () => {
    const schedules = fakeSchedules();
    patchWorkspaceSchedule("ws-1", { ...VALID, endAt: "2026-08-01T00:00" }, deps(schedules));
    expect(patchWorkspaceSchedule("ws-1", { endAt: null }, deps(schedules))).not.toHaveProperty("endAt");
    expect(() => patchWorkspaceSchedule("ws-1", { bogus: true } as ScheduleInput, deps(schedules))).toThrow(
      "unknown field bogus",
    );
    expect(schedules.writes).toHaveLength(2);
  });
});

describe("presenting a schedule", () => {
  const paris: ScheduleEntry = {
    ...stored,
    timezone: "Europe/Paris",
    endAt: "2026-07-31T18:00",
    lastRun: { at: "2026-07-12T09:00:11.850Z", status: "error", conversationId: "conv-1", error: "no key" },
  };

  it("shows every recorded time on the schedule's clock and settings as stored", () => {
    expect(presentSchedule(paris)).toEqual({
      id: "existing-id",
      workspaceId: "ws-1",
      prompt: "the old prompt",
      intervalValue: 2,
      intervalUnit: "hour",
      startAt: "2026-07-01T09:00",
      endAt: "2026-07-31T18:00",
      timezone: "Europe/Paris",
      enabled: true,
      createdAt: "2026-07-01T02:00+02:00",
      nextRunAt: "2026-07-13T11:00+02:00",
      lastRun: { at: "2026-07-12T11:00:11+02:00", status: "error", conversationId: "conv-1", error: "no key" },
    });
  });

  it("drops keys the entity does not have, at the top level and in the last run", () => {
    const record = {
      ...paris,
      lastRunConversationId: "old-conv",
      lastRunError: "old error",
      lastRun: { ...paris.lastRun, snippet: "retired" },
    } as ScheduleEntry;
    const shown = presentSchedule(record);
    expect(shown).not.toHaveProperty("lastRunConversationId");
    expect(shown).not.toHaveProperty("lastRunError");
    expect(shown.lastRun).not.toHaveProperty("snippet");
  });

  it("leaves a disabled, never-run schedule without a next or last run", () => {
    const shown = presentSchedule({ ...stored, enabled: false, nextRunAt: null, lastRun: undefined });
    expect(shown.nextRunAt).toBeNull();
    expect(shown).not.toHaveProperty("lastRun");
    expect(shown).not.toHaveProperty("endAt");
  });
});

it("refuses an enabled schedule whose next occurrence overflows the date range", () => {
  expect(() =>
    validateSchedule(
      {
        ...VALID,
        startAt: "+275760-09-12T00:00",
        intervalValue: 10000,
        intervalUnit: "week",
        enabled: true,
      },
      new Date(8640000000000000),
    ),
  ).toThrow("no representable future run");
});
