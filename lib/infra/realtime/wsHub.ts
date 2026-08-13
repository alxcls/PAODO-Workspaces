// Lightweight global registry of active WebSocket connections shared between the custom
// server (which owns the sockets) and the Next.js API routes that need to broadcast events.
//
// WHY global: in Next.js development mode the module system re-evaluates files on every
// hot-reload, which would reset a module-level Map and drop all live connections. Hanging
// state off `global` survives hot-reloads because the Node.js global object is never reset
// between reloads. The guard `if (!g._wsConnections)` ensures only one Map is ever created.
import type { WebSocket } from "ws";

const g = global as typeof global & { _wsConnections?: Map<string, Set<WebSocket>> };
if (!g._wsConnections) g._wsConnections = new Map();

const connections = g._wsConnections;

// How far behind a single socket may fall before we stop handing it more.
//
// WHY this exists: `ws.send()` never blocks. When the client cannot read as fast as we write — a
// backgrounded tab, a throttled phone, a laptop that went to sleep — the bytes do not wait in the
// kernel, they queue on OUR heap, and execute_command broadcasts every chunk of a command's output.
// A `find /` or a verbose build therefore parks its entire output in this process, once per connected
// tab, with nothing to stop it. That is the same unbounded-accumulation defect as execOutput.ts and
// dockerClient.ts, just reached through a socket instead of a string.
//
// 2MB is far past useful: the console panel keeps only the last 500 lines, so anything queued behind
// that much backlog is already scrolled out of existence before it can be rendered. Dropping it costs
// the viewer nothing real — and the drop is reported (console_dropped) rather than hidden.
const WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// A socket pinned at the ceiling this long is not a slow viewer, it is a dead one that has not
// finished dying (a closed laptop, a dropped network with no FIN). Terminating reclaims its buffer
// and its slot; the browser hook reconnects 2s later and resyncs, so a live viewer loses nothing.
const WS_STALL_MS = 30_000;

// Per-socket drop bookkeeping. WeakMap so an entry cannot outlive the socket it describes — this map
// is never cleaned up on disconnect, and must not be a reason a closed connection stays reachable.
const lagging = new WeakMap<WebSocket, { dropped: number; overSince: number }>();

/**
 * Send unless the socket is already too far behind, in which case drop the message instead of
 * queueing it. Every write to a client goes through here — a bound that some paths skip is not a
 * bound, since one unbounded caller is all it takes.
 */
/** Whether this socket is currently draining fast enough to be given more. */
function keepingUp(ws: WebSocket): boolean {
  return ws.readyState === 1 /* OPEN */ && ws.bufferedAmount <= WS_MAX_BUFFERED_BYTES;
}

function sendBounded(ws: WebSocket, data: string): void {
  const state = lagging.get(ws);

  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    const now = Date.now();
    if (!state) {
      lagging.set(ws, { dropped: 1, overSince: now });
      return;
    }
    state.dropped++;
    if (now - state.overSince >= WS_STALL_MS) {
      lagging.delete(ws);
      ws.terminate();
    }
    return;
  }

  if (state) {
    // Recovered. Tell the truth about the gap before resuming, so the console shows a break rather
    // than silently splicing two unrelated stretches of output together.
    lagging.delete(ws);
    ws.send(JSON.stringify({ type: "console_dropped", dropped: state.dropped }));
  }
  ws.send(data);
}

export function addConnection(workspaceId: string, ws: WebSocket): void {
  if (!connections.has(workspaceId)) connections.set(workspaceId, new Set());
  connections.get(workspaceId)!.add(ws);
}

export function removeConnection(workspaceId: string, ws: WebSocket): void {
  const set = connections.get(workspaceId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(workspaceId);
}

export function getConnectionCount(workspaceId: string): number {
  return connections.get(workspaceId)?.size ?? 0;
}

export function broadcastToWorkspace(workspaceId: string, data: string): void {
  const sockets = connections.get(workspaceId);
  if (!sockets) return;
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) sendBounded(ws, data);
  }
}

/**
 * Send to ONE connection for this workspace (the agent runner's notify seam).
 * Returns false when there is nobody connected — a run continues with no one watching.
 *
 * Prefers a socket that is keeping up rather than the first open one in iteration order. With two
 * tabs open, that order could put a backgrounded tab first, and the ceiling then turned every
 * tool_call and tool_result_log of the run into a drop while a foreground tab sat there draining
 * fine. The bound has to cost the tab that is behind, not the one that is watching.
 */
export function sendToWorkspace(workspaceId: string, data: string): boolean {
  const sockets = connections.get(workspaceId);
  if (!sockets) return false;
  let behind: WebSocket | null = null;
  for (const ws of sockets) {
    if (keepingUp(ws)) {
      sendBounded(ws, data);
      return true;
    }
    if (ws.readyState === 1 && !behind) behind = ws;
  }
  // Everyone connected is over the ceiling. Still go through sendBounded: it drops rather than
  // queues, and it is what accrues the stall bookkeeping that eventually lets a dead socket go.
  if (!behind) return false;
  sendBounded(behind, data);
  return true;
}
