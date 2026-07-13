// The reconciler periodically re-runs reattachProxyNetworks so a credproxy sidecar recreated while
// the app keeps running (an independent restart, not an app reboot) self-heals within one interval.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { reattach } = vi.hoisted(() => ({ reattach: vi.fn() }));
vi.mock("../services", () => ({
  getContainers: () => ({ reattachProxyNetworks: reattach }),
}));

import { startProxyReconciler, stopProxyReconciler, _reconcileTick } from "./proxyReconciler";

describe("proxyReconciler", () => {
  beforeEach(() => {
    reattach.mockReset();
    reattach.mockResolvedValue(undefined);
  });
  afterEach(() => {
    stopProxyReconciler();
    vi.useRealTimers();
  });

  it("a tick reattaches proxy networks", async () => {
    await _reconcileTick();
    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping ticks while one is still in flight", async () => {
    let release: () => void = () => {};
    reattach.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = _reconcileTick(); // sets running=true, awaits the pending reattach
    await _reconcileTick(); // should early-return without a second call
    expect(reattach).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("swallows tick errors so the interval loop survives", async () => {
    reattach.mockRejectedValueOnce(new Error("docker down"));
    await expect(_reconcileTick()).resolves.toBeUndefined();
  });

  it("start is idempotent (single interval registered)", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, "setInterval");
    startProxyReconciler();
    startProxyReconciler();
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it("fires reattach on the configured interval, and stop halts it", async () => {
    vi.useFakeTimers();
    startProxyReconciler();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reattach).toHaveBeenCalledTimes(1); // boot retry
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reattach).toHaveBeenCalledTimes(2); // regular interval
    stopProxyReconciler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reattach).toHaveBeenCalledTimes(2); // no further ticks after stop
  });

  it("uses the default interval when the configured value is invalid", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, "setInterval");
    process.env.PROXY_RECONCILE_TICK_MS = "-1";
    startProxyReconciler();
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    delete process.env.PROXY_RECONCILE_TICK_MS;
  });
});
