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
    if (ws.readyState === 1 /* OPEN */) ws.send(data);
  }
}

export function getWsForWorkspace(workspaceId: string): WebSocket | undefined {
  const sockets = connections.get(workspaceId);
  if (!sockets) return undefined;
  for (const ws of sockets) {
    if (ws.readyState === 1) return ws;
  }
  return undefined;
}
