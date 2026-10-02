import { describe, expect, it } from "vitest";
import { toForm, scheduleChanges } from "./scheduleForm";
import type { ScheduleEntry } from "@/lib/schedules/types";

const stored: ScheduleEntry = {
  id: "s1",
  workspaceId: "w1",
  createdAt: "2026-01-01T00:00Z",
  nextRunAt: null,
  prompt: "original",
  intervalValue: 1,
  intervalUnit: "day",
  timezone: "UTC",
  startAt: "2026-10-02T09:00:30.123",
  endAt: "2026-10-31",
  enabled: false,
};

describe("schedule form round trips", () => {
  it("retains date-only ends and sub-minute precision", () => {
    expect(toForm(stored)).toMatchObject({ startAt: stored.startAt, endAt: stored.endAt });
    expect(scheduleChanges(toForm(stored), {}, true)).toEqual({});
  });

  it("sends only edits while refreshed values remain visible", () => {
    const draft = { prompt: "my edit" };
    const refreshed = toForm({ ...stored, intervalValue: 5 });
    const form = { ...refreshed, ...draft };
    expect(form.intervalValue).toBe("5");
    expect(scheduleChanges(form, draft, true)).toEqual({ prompt: "my edit" });
  });

  it("clears an end bound explicitly and does not truncate numeric input", () => {
    const form = { ...toForm(stored), endAt: "", intervalValue: "1.5" };
    expect(scheduleChanges(form, { endAt: "", intervalValue: "1.5" }, true)).toEqual({
      endAt: null,
      intervalValue: 1.5,
    });
  });
});
