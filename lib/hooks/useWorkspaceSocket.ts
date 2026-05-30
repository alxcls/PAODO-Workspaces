"use client";
// Reconnecting WebSocket hook for a workspace. Calls onFilesChanged / onFilesDeleted when the
// server broadcasts filesystem events. Returns a stable sendMessage function for outbound messages
// (e.g. self_write notifications after saves). Handlers are captured in a ref so they never
// cause a reconnect when the parent re-renders.
import { useEffect, useRef, useCallback } from "react";

interface Handlers {
  onFilesChanged: (paths: string[]) => void;
  onFilesDeleted: (paths: string[]) => void;
}

export interface WorkspaceSocketHandle {
  sendMessage: (msg: object) => void;
}

export function useWorkspaceSocket(
  workspaceId: string,
  handlers: Handlers
): WorkspaceSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Handlers>(handlers);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set to true when the workspaceId lifecycle ends (unmount or workspaceId change) to stop reconnects.
  const cancelledRef = useRef(false);

  // Assign during render (not in an effect) so the ref is always current before any effect or
  // WS message handler runs — eliminates the post-commit stale-handler window.
  handlersRef.current = handlers;

  useEffect(() => {
    cancelledRef.current = false;

    function connect() {
      const ws = new WebSocket(`ws://${window.location.host}/ws?workspaceId=${workspaceId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 30_000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; paths?: string[] };
          if (msg.type === "files_changed" && msg.paths) {
            handlersRef.current.onFilesChanged(msg.paths);
          } else if (msg.type === "files_deleted" && msg.paths) {
            handlersRef.current.onFilesDeleted(msg.paths);
          }
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
        // wsRef.current === ws guards against reconnects from a stale socket after workspaceId change.
        if (!cancelledRef.current && wsRef.current === ws) {
          reconnectRef.current = setTimeout(connect, 2_000);
        }
      };
    }

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
      if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
      const ws = wsRef.current;
      if (ws) {
        // Null the ref first so onclose (which fires async) sees wsRef.current !== ws and skips reconnect.
        wsRef.current = null;
        if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
        else ws.close();
      }
    };
  }, [workspaceId]);

  const sendMessage = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { sendMessage };
}
