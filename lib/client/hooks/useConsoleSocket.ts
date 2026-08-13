// Streams a workspace's live console output over a reconnecting WebSocket. Each server message
// is mapped to a ConsoleLine by the MSG_HANDLERS map (stdout/stderr/exec_done/tool_call/
// tool_result_log) — add a key to support a new message type without touching dispatch (OCP).
// Auto-reconnects 2s after a drop, sends a 30s keep-alive ping, and caps the buffer at MAX_LINES.
// Returns the line buffer, connection state, and a clearLines action.
"use client";

import { useState, useEffect, useCallback } from "react";
import { isWsConnectionStale, wsReconnectDelayMs } from "@/lib/client/wsReconnect";

export interface ConsoleLine {
  type: "stdout" | "stderr" | "info" | "tool";
  text: string;
}

const MAX_LINES = 500;

type WsMsg = {
  type: string;
  data?: string;
  exitCode?: number | null;
  name?: string;
  args?: unknown;
  result?: string;
  dropped?: number;
};
type MsgHandler = (m: WsMsg) => ConsoleLine | null;

// Extend this map to handle new server message types without touching dispatch logic (OCP).
const MSG_HANDLERS: Record<string, MsgHandler> = {
  stdout: (m) => (m.data ? { type: "stdout", text: m.data } : null),
  stderr: (m) => (m.data ? { type: "stderr", text: m.data } : null),
  exec_done: (m) => ({ type: "info", text: `--- process exited (code ${m.exitCode ?? "?"}) ---` }),
  tool_call: (m) => (m.name ? { type: "tool", text: `▶ ${m.name}(${m.args ? JSON.stringify(m.args) : "{}"})` } : null),
  tool_result_log: (m) => (m.name ? { type: "info", text: `← ${m.name}: ${m.result ?? ""}` } : null),
  // The server stopped queueing for us because this tab had fallen too far behind to keep up (a
  // backgrounded or throttled tab). Shown as a visible break so the output either side of it is not
  // mistaken for one continuous stretch.
  console_dropped: (m) => ({
    type: "info",
    text: `--- ${m.dropped ?? 0} messages dropped (this tab fell behind) ---`,
  }),
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
    // Consecutive failures, reset on a successful open — see lib/client/wsReconnect.ts.
    let attempt = 0;
    // The stale advice is printed once per outage, not on every retry, so a long disconnect does not
    // fill the buffer with copies of itself.
    let staleNoticeShown = false;

    function connect() {
      if (cancelled) return;
      const socket = new WebSocket(
        `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws?workspaceId=${workspaceId}`,
      );
      ws = socket;

      socket.onopen = () => {
        setConnected(true);
        attempt = 0;
        staleNoticeShown = false;
        appendLine({ type: "info", text: `Connected to workspace ${workspaceId}` });
        pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, 30_000);
      };

      socket.onclose = () => {
        setConnected(false);
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (!cancelled && ws === socket) {
          attempt += 1;
          const delay = wsReconnectDelayMs(attempt);
          if (isWsConnectionStale(attempt) && !staleNoticeShown) {
            staleNoticeShown = true;
            // The likely cause at this point is a credential the browser can no longer present —
            // the /ws session cookie does not survive a server restart — and no amount of retrying
            // fixes that. A reload re-mints it from the cached Basic credentials.
            appendLine({ type: "stderr", text: "Still disconnected — reload the page to reconnect." });
          } else {
            appendLine({
              type: "info",
              text: `WebSocket disconnected. Reconnecting in ${Math.round(delay / 1000)}s…`,
            });
          }
          reconnectTimer = setTimeout(connect, delay);
        }
      };

      socket.onerror = () => appendLine({ type: "stderr", text: "WebSocket error." });

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WsMsg;
          const line = MSG_HANDLERS[msg.type]?.(msg);
          if (line) appendLine(line);
        } catch {
          /* ignore malformed */
        }
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
