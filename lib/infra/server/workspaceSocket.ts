/**
 * What happens once a /ws handshake has passed upgradeGate.ts: the socket joins its workspace, the
 * first one in starts the file watcher, and the last one out stops it after a grace period.
 * server.ts supplies the real dependencies; see requestGate.ts.
 */
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import type { createLogger } from "../logger";

export interface WorkspaceSocketDependencies {
  getWorkspace(workspaceId: string): { dir: string } | undefined;
  connections: {
    add(workspaceId: string, ws: WebSocket): void;
    remove(workspaceId: string, ws: WebSocket): void;
    count(workspaceId: string): number;
  };
  /** Owns its recoverable persistence error log and falls back to an empty index. */
  loadConversations(workspaceId: string): unknown;
  watcher: {
    ensure(workspaceId: string, dir: string): void;
    stop(workspaceId: string): void;
    markSelfWrite(workspaceDir: string, relPath: string): void;
  };
  clearTodos(workspaceId: string): void;
  log: ReturnType<typeof createLogger>;
  /** How long a workspace may sit with no socket before its watcher stops; a reload reconnects sooner. */
  idleGraceMs?: number;
}

export function createWorkspaceSocketHandler(
  deps: WorkspaceSocketDependencies,
): (ws: WebSocket, req: IncomingMessage) => void {
  const { connections, watcher, log } = deps;
  const idleGraceMs = deps.idleGraceMs ?? 5000;

  return (ws, req) => {
    const workspaceId = new URL(req.url ?? "", "http://localhost").searchParams.get("workspaceId") ?? undefined;

    if (!workspaceId) {
      ws.close(1008, "workspaceId query param required");
      return;
    }

    const workspace = deps.getWorkspace(workspaceId);
    if (!workspace) {
      ws.close(1008, "workspace not found");
      return;
    }

    const wasEmpty = connections.count(workspaceId) === 0;
    connections.add(workspaceId, ws);
    if (wasEmpty) {
      // First connection: load saved conversations so a returning user sees their history at once.
      deps.loadConversations(workspaceId);
      watcher.ensure(workspaceId, workspace.dir);
    }

    const cleanup = () => {
      connections.remove(workspaceId, ws);
      setTimeout(() => {
        if (connections.count(workspaceId) === 0) {
          watcher.stop(workspaceId);
          deps.clearTodos(workspaceId);
        }
      }, idleGraceMs);
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);

    ws.on("message", (data) => {
      let msg: { type: string; path?: string };
      try {
        msg = JSON.parse(data.toString()) as { type: string; path?: string };
      } catch {
        // ignore malformed messages
        return;
      }
      try {
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        if (msg.type === "self_write" && msg.path) watcher.markSelfWrite(workspace.dir, msg.path);
      } catch (err) {
        log.warn({ err, workspaceId, messageType: msg.type }, "websocket message handling failed");
      }
    });
  };
}
