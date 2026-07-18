import { describe, expect, it } from "vitest";
import { LogThrottle, sharedLogThrottle, throttleFields } from "./logThrottle";

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

  it("shares named throttles across module consumers", () => {
    const name = `test-${crypto.randomUUID()}`;
    const first = sharedLogThrottle(name);
    const second = sharedLogThrottle(name);

    expect(second).toBe(first);
    expect(first.record("auth").emit).toBe(true);
    expect(second.record("auth").emit).toBe(false);
  });
});

describe("throttleFields", () => {
  it("returns fields for the first event, null while suppressing, then the suppressed count", () => {
    let now = 1_000;
    const throttle = new LogThrottle(60_000, () => now);
    const fields = { ip: "10.0.0.1", event: "auth_unauthorized" };

    expect(throttleFields(throttle, "auth_unauthorized", fields)).toEqual(fields);
    expect(throttleFields(throttle, "auth_unauthorized", fields)).toBeNull();
    expect(throttleFields(throttle, "auth_unauthorized", fields)).toBeNull();

    now += 60_000;
    expect(throttleFields(throttle, "auth_unauthorized", fields)).toEqual({ ...fields, suppressed: 2 });
  });

  it("bounds durable writes to one per interval regardless of how many client IPs are seen", () => {
    const throttle = new LogThrottle(60_000, () => 1_000);
    const emitted = Array.from({ length: 500 }, (_, i) =>
      throttleFields(throttle, "rate_limited", { ip: `10.0.0.${i}`, event: "rate_limited" }),
    ).filter((f) => f !== null);

    expect(emitted).toHaveLength(1);
  });
});
