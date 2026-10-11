import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCHEDULE_TICK_MS, scheduleTickMs } from "./tick";

afterEach(() => vi.unstubAllEnvs());

describe("the schedule tick interval", () => {
  it("is the default when SCHEDULE_TICK_MS is not set", () => {
    vi.stubEnv("SCHEDULE_TICK_MS", undefined);
    expect(scheduleTickMs()).toBe(DEFAULT_SCHEDULE_TICK_MS);
  });

  it("is SCHEDULE_TICK_MS when that is a positive whole number", () => {
    vi.stubEnv("SCHEDULE_TICK_MS", "5000");
    expect(scheduleTickMs()).toBe(5000);
  });

  it.each(["", "0", "-5", "10abc", "1.5", "Infinity"])("falls back to the default for %j", (value) => {
    vi.stubEnv("SCHEDULE_TICK_MS", value);
    expect(scheduleTickMs()).toBe(DEFAULT_SCHEDULE_TICK_MS);
  });
});
