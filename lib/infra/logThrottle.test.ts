import { beforeEach, describe, expect, it } from "vitest";
import { resetLogThrottle, throttleLog, throttleLogWithSources } from "./logThrottle";

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

describe("throttleLogWithSources", () => {
  const WITH_SOURCES = "mcp_auth_unauthorized";

  it("throttles exactly like throttleLog", () => {
    const t = 1_000_000;
    expect(throttleLogWithSources(WITH_SOURCES, "1.1.1.1", t)).not.toBeNull();
    for (let i = 1; i < 500; i++) expect(throttleLogWithSources(WITH_SOURCES, "1.1.1.1", t + i)).toBeNull();
  });

  it("separates one persistent caller from a distributed campaign", () => {
    const t = 1_000_000;
    // A single address hammering the endpoint.
    throttleLogWithSources(WITH_SOURCES, "1.1.1.1", t);
    for (let i = 1; i < 200; i++) throttleLogWithSources(WITH_SOURCES, "1.1.1.1", t + i);

    const single = throttleLogWithSources(WITH_SOURCES, "9.9.9.9", t + WINDOW);
    expect(single).toEqual({ suppressed: 199, sources: ["1.1.1.1"], sourcesTruncated: false });

    // Same volume, spread across many addresses: the count alone would look identical.
    for (let i = 1; i < 200; i++) throttleLogWithSources(WITH_SOURCES, `10.0.0.${i}`, t + WINDOW + i);

    const distributed = throttleLogWithSources(WITH_SOURCES, "9.9.9.9", t + 2 * WINDOW);
    expect(distributed?.suppressed).toBe(199);
    expect(distributed?.sourcesTruncated).toBe(true);
  });

  it("caps remembered addresses so a flood cannot grow the map", () => {
    const t = 1_000_000;
    throttleLogWithSources(WITH_SOURCES, "0.0.0.0", t);
    for (let i = 1; i < 5_000; i++) throttleLogWithSources(WITH_SOURCES, `10.1.${i >> 8}.${i & 255}`, t + i);

    const next = throttleLogWithSources(WITH_SOURCES, "9.9.9.9", t + WINDOW);
    expect(next?.sources.length).toBe(20);
    expect(next?.sourcesTruncated).toBe(true);
  });

  it("includes the address that opened the window, not just the suppressed ones", () => {
    const t = 1_000_000;
    throttleLogWithSources(WITH_SOURCES, "1.1.1.1", t);
    throttleLogWithSources(WITH_SOURCES, "2.2.2.2", t + 1);

    const next = throttleLogWithSources(WITH_SOURCES, "9.9.9.9", t + WINDOW);
    expect(next?.sources).toEqual(["1.1.1.1", "2.2.2.2"]);
  });

  it("shares windows with throttleLog so one flood is one line whichever door it uses", () => {
    const t = 1_000_000;
    expect(throttleLog("auth_blocked", t)).toBe(0);
    expect(throttleLogWithSources("auth_blocked", "1.1.1.1", t + 1)).toBeNull();
  });
});
