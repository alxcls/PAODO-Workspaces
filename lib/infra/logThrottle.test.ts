import { describe, expect, it } from "vitest";
import { LogThrottle } from "./logThrottle";

describe("LogThrottle", () => {
  it("emits immediately, suppresses repeats, and reports the suppressed count", () => {
    let now = 1_000;
    const throttle = new LogThrottle(60_000, () => now);

    expect(throttle.record("proxy")).toEqual({ emit: true, suppressed: 0 });
    expect(throttle.record("proxy")).toEqual({ emit: false });
    expect(throttle.record("proxy")).toEqual({ emit: false });

    now += 60_000;
    expect(throttle.record("proxy")).toEqual({ emit: true, suppressed: 2 });
  });

  it("tracks keys independently and forget resets a key", () => {
    const throttle = new LogThrottle();
    expect(throttle.record("a").emit).toBe(true);
    expect(throttle.record("a").emit).toBe(false);
    expect(throttle.record("b").emit).toBe(true);
    throttle.forget("a");
    expect(throttle.record("a").emit).toBe(true);
  });
});
