"use client";
import { useState, useEffect, useCallback } from "react";

export interface ConsoleLine {
  type: "stdout" | "stderr" | "info" | "tool";
  text: string;
}

const MAX_LINES = 500;

type WsMsg = { type: string; data?: string; exitCode?: number | null; name?: string; args?: unknown; result?: string };
type MsgHandler = (m: WsMsg) => ConsoleLine | null;

// Extend this map to handle new server message types without touching dispatch logic (OCP).
const MSG_HANDLERS: Record<string, MsgHandler> = {
  stdout:          (m) => m.data ? { type: "stdout", text: m.data } : null,
  stderr:          (m) => m.data ? { type: "stderr", text: m.data } : null,
  exec_done:       (m) => ({ type: "info", text: `--- process exited (code ${m.exitCode ?? "?"}) ---` }),
  tool_call:       (m) => m.name ? { type: "tool", text: `▶ ${m.name}(${m.args ? JSON.stringify(m.args) : "{}"})` } : null,
  tool_result_log: (m) => m.name ? { type: "info", text: `← ${m.name}: ${m.result ?? ""}` } : null,
};

export function useConsoleSocket(workspaceId: string) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [connected, setConnected] = useState(false);

  const appendLine = useCallback((line: ConsoleLine) => {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    function connect() {
      if (cancelled) return;
      const socket = new WebSocket(
        `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws?workspaceId=${workspaceId}`
      );
      ws = socket;

      socket.onopen = () => {
        setConnected(true);
        appendLine({ type: "info", text: `Connected to workspace ${workspaceId}` });
        pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, 30_000);
      };

      socket.onclose = () => {
        setConnected(false);
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (!cancelled && ws === socket) {
          appendLine({ type: "info", text: "WebSocket disconnected. Reconnecting in 2s…" });
          reconnectTimer = setTimeout(connect, 2_000);
        }
      };

      socket.onerror = () => appendLine({ type: "stderr", text: "WebSocket error." });

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WsMsg;
          const line = MSG_HANDLERS[msg.type]?.(msg);
          if (line) appendLine(line);
        } catch { /* ignore malformed */ }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingInterval) clearInterval(pingInterval);
      const s = ws;
      ws = null;
      if (s) {
        if (s.readyState === WebSocket.CONNECTING) s.onopen = () => s.close();
        else s.close();
      }
    };
  }, [workspaceId, appendLine]);

  const clearLines = useCallback(() => setLines([]), []);

  return { lines, connected, clearLines };
}
