// computeNextRun must anchor to startAt, advance in wall-clock time in the zone (surviving DST), honour
// an end bound, and fast-forward past a long-elapsed anchor without drift.
import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { computeNextRun, endBound, isValidTimezone, nextRunIso, onScheduleClock } from "./nextRun";
import type { ScheduleEntry, IntervalUnit } from "./types";

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

  it("keeps interval phase when startAt is far in the past", () => {
    const next = computeNextRun(
      entry({ startAt: "2020-01-01T09:17", intervalUnit: "hour", intervalValue: 2, timezone: "UTC" }),
      iso("2026-07-13T10:12:00Z"),
    );
    expect(next?.toISOString()).toBe("2026-07-13T11:17:00.000Z");
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
    const e = entry({
      startAt: "2026-03-27T09:00",
      intervalUnit: "day",
      intervalValue: 1,
      timezone: "Europe/Brussels",
    });
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
    const e = entry({
      startAt: "2026-07-13T09:00",
      intervalUnit: "day",
      intervalValue: 1,
      endAt: "2026-07-15",
      timezone: "UTC",
    });
    // After the end date entirely -> expired.
    expect(computeNextRun(e, iso("2026-07-16T00:00:00Z"))).toBeNull();
    // On the 14th the schedule still fires.
    expect(computeNextRun(e, iso("2026-07-13T12:00:00Z"))).not.toBeNull();
  });

  it("uses a date-time end as an exact cutoff for a working-hours schedule", () => {
    const e = entry({
      startAt: "2026-07-13T09:00",
      intervalUnit: "minute",
      intervalValue: 30,
      endAt: "2026-07-13T18:00",
      timezone: "Europe/Brussels",
    });

    // 15:00Z is 17:00 locally, so the next half-hour run is still inside the window.
    expect(computeNextRun(e, iso("2026-07-13T15:00:00Z"))?.toISOString()).toBe("2026-07-13T15:30:00.000Z");
    // At 17:30 locally, the next occurrence would equal the 18:00 cutoff and is not scheduled.
    expect(computeNextRun(e, iso("2026-07-13T15:30:00Z"))).toBeNull();
  });

  it("returns null for an interval below 1", () => {
    expect(computeNextRun(entry({ intervalValue: 0 }), iso("2026-07-13T10:00:00Z"))).toBeNull();
  });

  it("returns null for an unparseable start", () => {
    expect(computeNextRun(entry({ startAt: "not-a-date" }), iso("2026-07-13T10:00:00Z"))).toBeNull();
  });
});

describe("endBound", () => {
  // The save check reads the bound through this too, so a same-day date-only end is accepted there.
  it("ends a date-only bound at the close of that day in the zone, and a date-time exactly", () => {
    expect(endBound({ endAt: "2026-10-05", timezone: "Europe/Paris" })?.toISO()).toBe("2026-10-05T23:59:59.999+02:00");
    expect(endBound({ endAt: "2026-10-05T18:00", timezone: "Europe/Paris" })?.toISO()).toBe(
      "2026-10-05T18:00:00.000+02:00",
    );
  });

  it("is null without a readable end", () => {
    expect(endBound({ timezone: "UTC" })).toBeNull();
    expect(endBound({ endAt: "2026-10-05 18:00", timezone: "UTC" })).toBeNull();
  });
});

describe("isValidTimezone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimezone("Europe/Brussels")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
  });
});

describe("nextRunIso", () => {
  // Paris skips 02:00–03:00 on 2026-03-29: a 02:30 start fires at 03:30, which `…01:30Z` hid.
  it("writes the next run on the schedule's clock, so a DST shift shows beside startAt", () => {
    const paris = entry({ startAt: "2026-03-29T02:30", timezone: "Europe/Paris" });
    expect(nextRunIso(paris, iso("2026-03-28T12:00Z"))).toBe("2026-03-29T03:30+02:00");
    expect(nextRunIso(entry(), iso("2026-07-12T00:00Z"))).toBe("2026-07-13T09:00Z");
  });

  it("is null when the schedule is disabled", () => {
    expect(nextRunIso(entry({ enabled: false }), iso("2026-07-12T00:00Z"))).toBeNull();
  });
});

describe("onScheduleClock", () => {
  it("writes a UTC instant on the schedule's clock with its offset, without milliseconds", () => {
    expect(onScheduleClock("2026-10-02T17:09:11.850Z", "Europe/Paris")).toBe("2026-10-02T19:09:11+02:00");
    expect(onScheduleClock("2026-12-02T17:09:11.850Z", "Europe/Paris")).toBe("2026-12-02T18:09:11+01:00");
  });

  it("keeps seconds only when they are not zero", () => {
    expect(onScheduleClock(iso("2026-10-02T07:00:00.000Z"), "Europe/Paris")).toBe("2026-10-02T09:00+02:00");
  });

  it("re-expresses an instant already carrying an offset without moving it", () => {
    expect(onScheduleClock("2026-10-02T19:09+02:00", "Asia/Tokyo")).toBe("2026-10-03T02:09+09:00");
  });

  it("is null for an unreadable instant", () => {
    expect(onScheduleClock("not a date", "Europe/Paris")).toBeNull();
  });
});

describe("recurrence safety", () => {
  it.each([1e300, 1e9, 1e12, Infinity, NaN, 0, -1, 1.5])(
    "rejects unsafe interval %s without searching",
    (intervalValue) => {
      expect(computeNextRun(entry({ intervalValue }), iso("2026-07-14T00:00Z"))).toBeNull();
    },
  );

  it("returns to the original wall clock after a spring DST gap", () => {
    const e = entry({ startAt: "2026-03-27T02:30", timezone: "Europe/Paris" });
    expect(computeNextRun(e, iso("2026-03-29T02:00Z"))?.toISOString()).toBe("2026-03-30T00:30:00.000Z");
  });

  it("keeps the original clock after the autumn offset change", () => {
    const e = entry({ startAt: "2026-10-23T02:30", timezone: "Europe/Paris" });
    expect(computeNextRun(e, iso("2026-10-25T03:00Z"))?.toISOString()).toBe("2026-10-26T01:30:00.000Z");
  });

  it("rejects an invalid comparison date and corrupt interval unit", () => {
    expect(computeNextRun(entry(), new Date(NaN))).toBeNull();
    expect(computeNextRun(entry({ intervalUnit: "bad" as IntervalUnit }), iso("2026-07-14T00:00Z"))).toBeNull();
  });
});
