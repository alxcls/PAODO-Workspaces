// The SSE keepalive exists so a stream that goes silent for minutes (a long tool call emits
// nothing between tool_start and tool_result) is not dropped as idle by a proxy. These pin the
// three properties that matter: it emits on schedule, it stops on demand, and it never throws
// after the stream is gone.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startKeepalive, SSE_KEEPALIVE_MS, SSE_HEADERS } from "./sse";

// Minimal stand-in for the controller half of a ReadableStream, recording what was enqueued and
// able to simulate a closed stream (which throws on enqueue, as the real one does).
function fakeController() {
  const frames: string[] = [];
  const decoder = new TextDecoder();
  let closed = false;
  return {
    frames,
    close: () => {
      closed = true;
    },
    controller: {
      enqueue(chunk: Uint8Array) {
        if (closed) throw new TypeError("Controller is already closed");
        frames.push(decoder.decode(chunk));
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>,
  };
}

describe("startKeepalive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits a comment frame on each interval", () => {
    const { controller, frames } = fakeController();
    startKeepalive(controller, new TextEncoder(), 1000);

    vi.advanceTimersByTime(3000);

    expect(frames).toEqual([": ping\n\n", ": ping\n\n", ": ping\n\n"]);
  });

  it("emits nothing once stopped", () => {
    const { controller, frames } = fakeController();
    const stop = startKeepalive(controller, new TextEncoder(), 1000);

    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(5000);

    expect(frames).toHaveLength(1);
  });

  // A tick racing a stream teardown must not throw out of the timer callback, where nothing
  // would catch it.
  it("swallows enqueue failures after the stream closes", () => {
    const { controller, close, frames } = fakeController();
    startKeepalive(controller, new TextEncoder(), 1000);

    close();

    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    expect(frames).toEqual([]);
  });

  it("defaults to an interval well under the ~100s proxies allow", () => {
    expect(SSE_KEEPALIVE_MS).toBeLessThan(100_000);
  });

  it("declares headers that keep proxies from buffering the stream", () => {
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream");
    expect(SSE_HEADERS["Cache-Control"]).toContain("no-transform");
    expect(SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
  });
});
