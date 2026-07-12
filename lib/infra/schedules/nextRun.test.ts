// computeNextRun is the recurrence engine: it must anchor to startAt, advance in wall-clock time
// within the schedule's zone (so day/week intervals survive DST), honour an end bound, and
// fast-forward past a long-elapsed anchor without drift.
import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { computeNextRun, isValidTimezone } from "./nextRun";
import type { ScheduleEntry, IntervalUnit } from "./scheduleStore";

function entry(over: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: "s1",
    workspaceId: "w1",
    prompt: "run",
    intervalValue: 1,
    intervalUnit: "day" as IntervalUnit,
    startAt: "2026-07-13T09:00",
    timezone: "UTC",
    enabled: true,
    createdAt: "2026-07-12T00:00:00.000Z",
    nextRunAt: null,
    ...over,
  };
}

const iso = (s: string) => new Date(s);

describe("computeNextRun", () => {
  it("returns the start anchor itself when it is in the future", () => {
    const next = computeNextRun(entry({ startAt: "2026-07-13T09:00", timezone: "UTC" }), iso("2026-07-13T08:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-13T09:00:00.000Z");
  });

  it("aligns to the anchor and lands strictly after `after` for minute intervals", () => {
    const next = computeNextRun(
      entry({ startAt: "2020-01-01T00:00", intervalUnit: "minute", intervalValue: 30, timezone: "UTC" }),
      iso("2026-07-13T10:12:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-07-13T10:30:00.000Z");
  });

  it("never returns a time equal to `after` (strictly after)", () => {
    const next = computeNextRun(
      entry({ startAt: "2020-01-01T00:00", intervalUnit: "hour", intervalValue: 1, timezone: "UTC" }),
      iso("2026-07-13T10:00:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-07-13T11:00:00.000Z");
  });

  it("keeps wall-clock time across a DST transition for day intervals", () => {
    // Europe/Brussels springs forward on 2026-03-29 (CET +01 -> CEST +02).
    const e = entry({ startAt: "2026-03-27T09:00", intervalUnit: "day", intervalValue: 1, timezone: "Europe/Brussels" });
    const next = computeNextRun(e, iso("2026-03-30T00:00:00Z"));
    expect(next).not.toBeNull();
    // 09:00 local must be preserved despite the offset change.
    expect(DateTime.fromJSDate(next!).setZone("Europe/Brussels").toFormat("HH:mm")).toBe("09:00");
  });

  it("interprets the start anchor in the schedule's timezone", () => {
    // 09:00 in Asia/Tokyo (UTC+9) is 00:00Z.
    const next = computeNextRun(
      entry({ startAt: "2026-07-13T09:00", timezone: "Asia/Tokyo" }),
      iso("2026-07-13T00:00:00Z"),
    );
    // 09:00 JST on the 13th is exactly `after` (00:00Z) -> next is the following day.
    expect(DateTime.fromJSDate(next!).setZone("Asia/Tokyo").toFormat("HH:mm")).toBe("09:00");
    expect(next!.toISOString()).toBe("2026-07-14T00:00:00.000Z");
  });

  it("returns null once past the end bound (date-only end is inclusive of that day)", () => {
    const e = entry({ startAt: "2026-07-13T09:00", intervalUnit: "day", intervalValue: 1, endAt: "2026-07-15", timezone: "UTC" });
    // After the end date entirely -> expired.
    expect(computeNextRun(e, iso("2026-07-16T00:00:00Z"))).toBeNull();
    // On the 14th the schedule is still live.
    expect(computeNextRun(e, iso("2026-07-13T12:00:00Z"))).not.toBeNull();
  });

  it("returns null for an interval below 1", () => {
    expect(computeNextRun(entry({ intervalValue: 0 }), iso("2026-07-13T10:00:00Z"))).toBeNull();
  });

  it("returns null for an unparseable start", () => {
    expect(computeNextRun(entry({ startAt: "not-a-date" }), iso("2026-07-13T10:00:00Z"))).toBeNull();
  });
});

describe("isValidTimezone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimezone("Europe/Brussels")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
  });
});
