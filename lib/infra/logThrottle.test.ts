import { beforeEach, describe, expect, it } from "vitest";
import { resetLogThrottle, throttleLog } from "./logThrottle";

const WINDOW = 10_000;

beforeEach(() => resetLogThrottle());

describe("throttleLog", () => {
  it("emits the first event in a window and drops the rest", () => {
    const t = 1_000_000;
    expect(throttleLog("rate_limited", t)).toBe(0);
    for (let i = 1; i < 500; i++) expect(throttleLog("rate_limited", t + i)).toBeNull();
  });

  it("reports how many events the next emission stood in for", () => {
    const t = 1_000_000;
    throttleLog("rate_limited", t);
    for (let i = 0; i < 49; i++) throttleLog("rate_limited", t + 100);

    // 50 events total: one emitted, 49 suppressed, reported on the first event of the next window.
    expect(throttleLog("rate_limited", t + WINDOW)).toBe(49);
  });

  it("keeps distinct events independent", () => {
    const t = 1_000_000;
    expect(throttleLog("auth_blocked", t)).toBe(0);
    expect(throttleLog("csrf_blocked", t)).toBe(0);
    expect(throttleLog("auth_blocked", t + 1)).toBeNull();
  });

  it("bounds a flood spread across many client addresses", () => {
    // The key is the event name alone, never the address — a distributed scan is the case this
    // exists for, and per-address keys would let it through one line per address.
    const t = 1_000_000;
    let emitted = 0;
    for (let i = 0; i < 10_000; i++) {
      if (throttleLog("auth_unauthorized", t + i) !== null) emitted++;
    }
    // 10k events spanning just under one window: a single line, not 10k.
    expect(emitted).toBe(1);
  });
});
