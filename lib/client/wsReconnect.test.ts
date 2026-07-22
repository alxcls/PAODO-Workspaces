// The failure this schedule exists to prevent is an unbounded fast retry loop: a handshake the
// browser cannot satisfy used to be retried every 2s forever. So the assertions that matter are the
// growth and the cap, not the exact numbers.
import { describe, it, expect } from "vitest";

import { WS_RECONNECT_DELAYS_MS, isWsConnectionStale, wsReconnectDelayMs } from "./wsReconnect";

// Pin the jitter to its midpoint so delays are exact; jitter itself is asserted separately.
const noJitter = () => 0.5;

describe("wsReconnectDelayMs", () => {
  it("grows with each consecutive failure", () => {
    const delays = [1, 2, 3, 4, 5].map((n) => wsReconnectDelayMs(n, noJitter));
    expect(delays).toEqual(WS_RECONNECT_DELAYS_MS);
  });

  it("caps instead of growing without bound", () => {
    const cap = WS_RECONNECT_DELAYS_MS[WS_RECONNECT_DELAYS_MS.length - 1];
    expect(wsReconnectDelayMs(50, noJitter)).toBe(cap);
    expect(wsReconnectDelayMs(5_000, noJitter)).toBe(cap);
  });

  it("never returns a delay below the first step, whatever the attempt number", () => {
    // A zero or negative attempt must not degrade into a hot loop.
    for (const attempt of [0, -1, -100]) {
      expect(wsReconnectDelayMs(attempt, noJitter)).toBe(WS_RECONNECT_DELAYS_MS[0]);
    }
  });

  it("jitters within ±20% so simultaneous drops do not retry in lockstep", () => {
    const base = WS_RECONNECT_DELAYS_MS[0];
    expect(wsReconnectDelayMs(1, () => 0)).toBe(base * 0.8);
    expect(wsReconnectDelayMs(1, () => 1)).toBe(base * 1.2);
  });
});

describe("isWsConnectionStale", () => {
  it("stays false while the outage still looks like a blip", () => {
    expect(isWsConnectionStale(1)).toBe(false);
    expect(isWsConnectionStale(WS_RECONNECT_DELAYS_MS.length - 1)).toBe(false);
  });

  it("turns true once the schedule is exhausted", () => {
    expect(isWsConnectionStale(WS_RECONNECT_DELAYS_MS.length)).toBe(true);
    expect(isWsConnectionStale(WS_RECONNECT_DELAYS_MS.length + 10)).toBe(true);
  });
});
