// The hub is the last unbounded output path of the three. `ws.send()` does not block, so when a
// client stops reading — a backgrounded tab, a sleeping laptop — the bytes queue on this process's
// heap, not in the kernel. execute_command broadcasts every chunk of a command's output, once per
// connected tab, so a single verbose command could park its whole output here N times over.
//
// Unlike the exec and docker-client caps there is no crash cliff to point at; it degrades into an
// OOM instead. What these tests pin is that the queue has a ceiling, that hitting it is reported
// rather than hidden, and that a socket stuck at the ceiling is eventually let go.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { WebSocket } from "ws";
import { addConnection, removeConnection, broadcastToWorkspace, sendToWorkspace } from "./wsHub";

type FakeSocket = WebSocket & { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };

function fakeSocket(readyState = 1): FakeSocket {
  return {
    readyState,
    bufferedAmount: 0,
    send: vi.fn(),
    terminate: vi.fn(),
  } as unknown as FakeSocket;
}

// The registry hangs off `global` (it must survive Next hot-reloads), so it is shared between tests
// in this file — each one uses its own workspace id and unregisters what it added.
function withSockets<T extends FakeSocket[]>(workspaceId: string, ...sockets: T): T {
  for (const ws of sockets) addConnection(workspaceId, ws);
  registered.push([workspaceId, sockets]);
  return sockets;
}
const registered: Array<[string, FakeSocket[]]> = [];

afterEach(() => {
  for (const [id, sockets] of registered.splice(0)) for (const ws of sockets) removeConnection(id, ws);
  vi.useRealTimers();
});

describe("broadcastToWorkspace backpressure", () => {
  it("delivers to every open socket and skips the ones that are not", () => {
    const [open, closing] = withSockets("ws_normal", fakeSocket(1), fakeSocket(2 /* CLOSING */));

    broadcastToWorkspace("ws_normal", "hello");

    expect(open.send).toHaveBeenCalledWith("hello");
    expect(closing.send).not.toHaveBeenCalled();
  });

  it("stops handing data to a socket that is already too far behind", () => {
    const [slow] = withSockets("ws_slow", fakeSocket());
    (slow as { bufferedAmount: number }).bufferedAmount = 4 * 1024 * 1024;

    for (let i = 0; i < 100; i++) broadcastToWorkspace("ws_slow", "chunk");

    // The whole point: the backlog is not ours to grow. Without this the 100 chunks — and the
    // megabytes a real command produces — accumulate in this process for as long as the tab sulks.
    expect(slow.send).not.toHaveBeenCalled();
  });

  it("does not penalise a socket that is merely busy", () => {
    const [busy] = withSockets("ws_busy", fakeSocket());
    (busy as { bufferedAmount: number }).bufferedAmount = 64 * 1024;

    broadcastToWorkspace("ws_busy", "chunk");

    expect(busy.send).toHaveBeenCalledWith("chunk");
  });

  it("reports the gap once when the socket catches up, then resumes", () => {
    const [slow] = withSockets("ws_recovered", fakeSocket());
    const buffered = slow as { bufferedAmount: number };

    buffered.bufferedAmount = 4 * 1024 * 1024;
    broadcastToWorkspace("ws_recovered", "a");
    broadcastToWorkspace("ws_recovered", "b");
    buffered.bufferedAmount = 0;
    broadcastToWorkspace("ws_recovered", "c");
    broadcastToWorkspace("ws_recovered", "d");

    // A silent gap would splice two unrelated stretches of output together and read as continuous.
    expect(slow.send.mock.calls.map(([m]) => m)).toEqual([
      JSON.stringify({ type: "console_dropped", dropped: 2 }),
      "c",
      "d",
    ]);
  });

  it("lets go of a socket that stays pinned at the ceiling", () => {
    vi.useFakeTimers();
    const [dead] = withSockets("ws_dead", fakeSocket());
    (dead as { bufferedAmount: number }).bufferedAmount = 4 * 1024 * 1024;

    broadcastToWorkspace("ws_dead", "a");
    vi.advanceTimersByTime(31_000);
    expect(dead.terminate).not.toHaveBeenCalled(); // nothing to notice until we try to send again

    broadcastToWorkspace("ws_dead", "b");

    // 30s pinned is a connection that died without saying so. Holding its buffer open forever costs
    // memory for a viewer that no longer exists; the browser hook reconnects and resyncs.
    expect(dead.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("sendToWorkspace", () => {
  it("picks an open socket and reports whether anyone was listening", () => {
    const [live] = withSockets("ws_notify", fakeSocket());

    expect(sendToWorkspace("ws_notify", "tool_call")).toBe(true);
    expect(live.send).toHaveBeenCalledWith("tool_call");
    // A run keeps going with nobody watching, so no listener is a normal outcome, not an error.
    expect(sendToWorkspace("ws_absent", "tool_call")).toBe(false);
  });

  it("is bounded too — the runner's notify is not a side door around the ceiling", () => {
    const [slow] = withSockets("ws_notify_slow", fakeSocket());
    (slow as { bufferedAmount: number }).bufferedAmount = 4 * 1024 * 1024;

    // Reported as delivered-to-someone; what it must not do is queue. A run emits a tool_call and a
    // tool_result_log per turn, each up to the 50k dispatch cap, so this path accumulates as well.
    sendToWorkspace("ws_notify_slow", "tool_result_log");

    expect(slow.send).not.toHaveBeenCalled();
  });
});
