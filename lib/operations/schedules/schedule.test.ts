// The schedule contract, tested where it now lives rather than through HTTP. Two things matter here
// and neither was reachable before: every rejection message (the CLI and any script read these as
// their only documentation of the accepted values), and the identity rule — a replace keeps the
// schedule's id, its creation time and its run history, because editing a prompt does not make it a
// different schedule.
import { describe, expect, it } from "vitest";
import { setWorkspaceSchedule, validateSchedule, type ScheduleInput } from "./schedule";
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
  lastRunAt: "2026-07-12T09:00:00.000Z",
  lastRunStatus: "ok",
  lastRunSnippet: "done",
};

describe("schedule validation", () => {
  it("canonicalizes the values it accepts", () => {
    expect(validateSchedule({ ...VALID, prompt: "  padded  ", endAt: "2026-08-01", enabled: true })).toEqual({
      prompt: "padded",
      intervalValue: 1,
      intervalUnit: "day",
      startAt: "2026-07-13T09:00",
      endAt: "2026-08-01",
      timezone: "UTC",
      enabled: true,
    });
  });

  // A schedule must never start firing from an omitted field, so an absent enable means paused.
  it("defaults enabled to false and treats a blank or null end bound as absent", () => {
    expect(validateSchedule(VALID).enabled).toBe(false);
    expect(validateSchedule({ ...VALID, enabled: true }).enabled).toBe(true);
    expect(validateSchedule({ ...VALID, endAt: null })).not.toHaveProperty("endAt");
    expect(validateSchedule({ ...VALID, endAt: "   " })).not.toHaveProperty("endAt");
  });

  // A paused schedule is a draft: it never fires, so an empty prompt is allowed and only becomes
  // required when the schedule is set live.
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
      "timezone must be a valid IANA timezone",
    );
    expect(() => validateSchedule({ ...VALID, startAt: "not-a-date" })).toThrow("startAt must be a valid date-time");
    expect(() => validateSchedule({ ...VALID, endAt: "not-a-date" })).toThrow("endAt must be a valid date");
    expect(() => validateSchedule({ ...VALID, endAt: "2026-07-01" })).toThrow("endAt must be after startAt");
  });

  it("rejects a request that omits a required field rather than inventing a default", () => {
    for (const field of ["prompt", "intervalValue", "intervalUnit", "startAt", "timezone"] as const) {
      // enabled: true so the prompt rule is in force — a paused schedule accepts an omitted prompt.
      const partial: ScheduleInput = { ...VALID, enabled: true };
      delete partial[field];
      expect(() => validateSchedule(partial)).toThrow(AppError);
    }
  });

  /**
   * The declared input types bind in-process callers; a JSON body only claims to match them. Without
   * these guards `prompt: 5` reached `.trim()` as a number and left this layer as a TypeError — an
   * opaque 500 rather than the named rejection every other bad value gets — and `enabled: "false"`
   * was truthy, so it stored a paused schedule as live and put a non-boolean in the file besides.
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
      nextRunAt: "2026-07-13T09:00:00.000Z",
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
      lastRunAt: "2026-07-12T09:00:00.000Z",
      lastRunStatus: "ok",
      lastRunSnippet: "done",
      // Recomputed from the new configuration, not carried over.
      prompt: "a new prompt",
      intervalUnit: "day",
    });
  });

  // The pointer is what the tick loop reads, so leaving one set would fire a schedule just paused.
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
});
