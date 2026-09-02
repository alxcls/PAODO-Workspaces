// The reaper periodically sweeps per-workspace networks that stop() emptied but no longer deletes
// inline, reclaiming the ones that stayed empty past the grace window.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { sweep } = vi.hoisted(() => ({ sweep: vi.fn() }));
vi.mock("../services", () => ({
  getContainers: () => ({ sweepManagedNetworks: sweep }),
}));

import { startNetworkReaper, stopNetworkReaper, _reapTick } from "./networkReaper";

describe("networkReaper", () => {
  beforeEach(() => {
    sweep.mockReset();
    sweep.mockResolvedValue(undefined);
  });
  afterEach(() => {
    stopNetworkReaper();
    vi.useRealTimers();
  });

  it("a tick sweeps managed networks", async () => {
    await _reapTick();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping ticks while one is still in flight", async () => {
    let release: () => void = () => {};
    sweep.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = _reapTick();
    await _reapTick();
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("swallows tick errors so the interval loop survives", async () => {
    sweep.mockRejectedValueOnce(new Error("docker down"));
    await expect(_reapTick()).resolves.toBeUndefined();
  });

  it("start is idempotent (single interval registered)", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, "setInterval");
    startNetworkReaper();
    startNetworkReaper();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("fires on the configured interval, and stop halts it", async () => {
    vi.useFakeTimers();
    process.env.NETWORK_REAP_TICK_MS = "30000";
    startNetworkReaper();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    stopNetworkReaper();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    delete process.env.NETWORK_REAP_TICK_MS;
  });

  it("uses the default interval when the configured value is invalid", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, "setInterval");
    process.env.NETWORK_REAP_TICK_MS = "-1";
    startNetworkReaper();
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 600_000);
    delete process.env.NETWORK_REAP_TICK_MS;
  });

  it("passes a configured grace override through to the sweep", async () => {
    process.env.NETWORK_REAP_GRACE_MS = "0";
    await _reapTick();
    expect(sweep).toHaveBeenCalledWith(0);
    delete process.env.NETWORK_REAP_GRACE_MS;
  });
});
