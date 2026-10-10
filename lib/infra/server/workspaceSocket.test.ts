// The handler decides when a workspace's file watcher runs. The failures that matter are a watcher
// that stops while someone is still looking, and one that never stops after everyone has left.
import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createWorkspaceSocketHandler, type WorkspaceSocketDependencies } from "./workspaceSocket";

class FakeSocket extends EventEmitter {
  send = vi.fn();
  close = vi.fn();
}

function setup() {
  const open = new Map<string, Set<unknown>>();
  const deps = {
    getWorkspace: vi.fn((id: string) => (id === "w1" || id === "w2" ? { dir: `/data/${id}` } : undefined)),
    connections: {
      add: vi.fn((id: string, ws: unknown) => void (open.get(id) ?? open.set(id, new Set()).get(id)!).add(ws)),
      remove: vi.fn((id: string, ws: unknown) => void open.get(id)?.delete(ws)),
      count: (id: string) => open.get(id)?.size ?? 0,
    },
    loadConversations: vi.fn(),
    watcher: { ensure: vi.fn(), stop: vi.fn(), markSelfWrite: vi.fn() },
    clearTodos: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const handler = createWorkspaceSocketHandler(deps as unknown as WorkspaceSocketDependencies);

  const connect = (url = "/ws?workspaceId=w1") => {
    const ws = new FakeSocket();
    handler(ws as unknown as WebSocket, { url } as IncomingMessage);
    return ws;
  };
  return { connect, deps };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("workspace socket — joining", () => {
  it("closes a connection that names no workspace", () => {
    const { connect, deps } = setup();
    const ws = connect("/ws");

    expect(ws.close).toHaveBeenCalledWith(1008, "workspaceId query param required");
    expect(deps.connections.add).not.toHaveBeenCalled();
    expect(deps.watcher.ensure).not.toHaveBeenCalled();
  });

  it("closes a connection to an unknown workspace", () => {
    const { connect, deps } = setup();
    const ws = connect("/ws?workspaceId=nope");

    expect(ws.close).toHaveBeenCalledWith(1008, "workspace not found");
    expect(deps.connections.add).not.toHaveBeenCalled();
    expect(deps.watcher.ensure).not.toHaveBeenCalled();
  });

  it("loads conversations and starts the watcher on the first connection", () => {
    const { connect, deps } = setup();
    const ws = connect();

    expect(ws.close).not.toHaveBeenCalled();
    expect(deps.connections.add).toHaveBeenCalledWith("w1", ws);
    expect(deps.loadConversations).toHaveBeenCalledWith("w1");
    expect(deps.watcher.ensure).toHaveBeenCalledWith("w1", "/data/w1");
  });

  it("does neither again for a second connection to the same workspace", () => {
    const { connect, deps } = setup();
    connect();
    connect();

    expect(deps.loadConversations).toHaveBeenCalledTimes(1);
    expect(deps.watcher.ensure).toHaveBeenCalledTimes(1);
  });

  it("starts a separate watcher for each workspace", () => {
    const { connect, deps } = setup();
    connect();
    connect("/ws?workspaceId=w2");

    expect(deps.watcher.ensure).toHaveBeenCalledWith("w2", "/data/w2");
    expect(deps.watcher.ensure).toHaveBeenCalledTimes(2);
  });
});

describe("workspace socket — leaving", () => {
  it("stops the watcher and clears todos only once the grace period has passed", () => {
    const { connect, deps } = setup();
    connect().emit("close");

    vi.advanceTimersByTime(4999);
    expect(deps.watcher.stop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(deps.watcher.stop).toHaveBeenCalledWith("w1");
    expect(deps.clearTodos).toHaveBeenCalledWith("w1");
  });

  // A page reload closes the socket and opens a new one a moment later.
  it("keeps the watcher running when someone reconnects inside the grace period", () => {
    const { connect, deps } = setup();
    connect().emit("close");
    vi.advanceTimersByTime(1000);
    connect();
    vi.advanceTimersByTime(10_000);

    expect(deps.watcher.stop).not.toHaveBeenCalled();
    expect(deps.clearTodos).not.toHaveBeenCalled();
  });

  it("stops nothing while another connection to the workspace is still open", () => {
    const { connect, deps } = setup();
    const first = connect();
    connect();
    first.emit("close");
    vi.advanceTimersByTime(10_000);

    expect(deps.connections.remove).toHaveBeenCalledWith("w1", first);
    expect(deps.watcher.stop).not.toHaveBeenCalled();
  });

  it("leaves another workspace's watcher alone", () => {
    const { connect, deps } = setup();
    connect("/ws?workspaceId=w2");
    connect().emit("close");
    vi.advanceTimersByTime(10_000);

    expect(deps.watcher.stop).toHaveBeenCalledTimes(1);
    expect(deps.watcher.stop).toHaveBeenCalledWith("w1");
  });

  it("cleans up after a socket error the same way as after a close", () => {
    const { connect, deps } = setup();
    const ws = connect();
    ws.emit("error", new Error("reset"));
    vi.advanceTimersByTime(5000);

    expect(deps.connections.remove).toHaveBeenCalledWith("w1", ws);
    expect(deps.watcher.stop).toHaveBeenCalledWith("w1");
  });

  // ws emits both for a broken socket, so cleanup runs twice. Harmless, and pinned here as such.
  it("tolerates an error followed by a close on the same socket", () => {
    const { connect, deps } = setup();
    const ws = connect();
    ws.emit("error", new Error("reset"));
    ws.emit("close");
    connect();
    vi.advanceTimersByTime(10_000);

    expect(deps.watcher.stop).not.toHaveBeenCalled();
  });
});

describe("workspace socket — messages", () => {
  it("answers ping with pong", () => {
    const { connect } = setup();
    const ws = connect();
    ws.emit("message", Buffer.from('{"type":"ping"}'));

    expect(ws.send).toHaveBeenCalledWith('{"type":"pong"}');
  });

  it("records a self_write against the workspace directory", () => {
    const { connect, deps } = setup();
    connect().emit("message", Buffer.from('{"type":"self_write","path":"src/a.ts"}'));

    expect(deps.watcher.markSelfWrite).toHaveBeenCalledWith("/data/w1", "src/a.ts");
  });

  it("ignores a self_write with no path", () => {
    const { connect, deps } = setup();
    connect().emit("message", Buffer.from('{"type":"self_write"}'));

    expect(deps.watcher.markSelfWrite).not.toHaveBeenCalled();
  });

  it("ignores malformed and unknown messages without logging", () => {
    const { connect, deps } = setup();
    const ws = connect();
    ws.emit("message", Buffer.from("not json"));
    ws.emit("message", Buffer.from('{"type":"something_else"}'));

    expect(ws.send).not.toHaveBeenCalled();
    expect(deps.log.warn).not.toHaveBeenCalled();
  });

  it("logs one warning instead of throwing when replying fails", () => {
    const { connect, deps } = setup();
    const ws = connect();
    ws.send.mockImplementation(() => {
      throw new Error("socket is closing");
    });

    expect(() => ws.emit("message", Buffer.from('{"type":"ping"}'))).not.toThrow();
    expect(deps.log.warn).toHaveBeenCalledTimes(1);
    expect(deps.log.warn.mock.calls[0][0]).toMatchObject({ workspaceId: "w1", messageType: "ping" });
  });
});
