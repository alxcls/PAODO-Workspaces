// Real-time console panel that maintains a WebSocket connection and displays streamed stdout, stderr,
// tool calls, and process exit events from the agent. Reconnects automatically on disconnect.
// Caps the line buffer at 500 entries to avoid unbounded memory growth.
"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface ConsoleLine {
  type: "stdout" | "stderr" | "info" | "tool";
  text: string;
}

function lineClass(type: ConsoleLine["type"]): string {
  switch (type) {
    case "tool":   return "console-line console-call";
    case "stderr": return "console-line console-err";
    case "info":   return "console-line console-result";
    default:       return "console-line console-out";
  }
}

export default function ConsolePanel({ workspaceId }: { workspaceId: string }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmounted = useRef(false);

  const appendLine = useCallback((line: ConsoleLine) => {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  useEffect(() => {
    unmounted.current = false;

    function connect() {
      if (unmounted.current) return;
      const wsUrl = `ws://${window.location.host}/ws?workspaceId=${workspaceId}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        appendLine({ type: "info", text: `Connected to workspace ${workspaceId}` });
        pingInterval.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);
      };

      ws.onclose = () => {
        setConnected(false);
        if (pingInterval.current) clearInterval(pingInterval.current);
        if (!unmounted.current && wsRef.current === ws) {
          appendLine({ type: "info", text: "WebSocket disconnected. Reconnecting in 2s…" });
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        appendLine({ type: "stderr", text: "WebSocket error." });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            data?: string;
            exitCode?: number | null;
            name?: string;
            args?: unknown;
            result?: string;
          };

          if (msg.type === "stdout" && msg.data) {
            appendLine({ type: "stdout", text: msg.data });
          } else if (msg.type === "stderr" && msg.data) {
            appendLine({ type: "stderr", text: msg.data });
          } else if (msg.type === "exec_done") {
            appendLine({ type: "info", text: `--- process exited (code ${msg.exitCode ?? "?"}) ---` });
          } else if (msg.type === "tool_call" && msg.name) {
            const argsStr = msg.args ? JSON.stringify(msg.args) : "{}";
            appendLine({ type: "tool", text: `▶ ${msg.name}(${argsStr})` });
          } else if (msg.type === "tool_result_log" && msg.name) {
            appendLine({ type: "info", text: `← ${msg.name}: ${msg.result ?? ""}` });
          }
        } catch { /* ignore malformed */ }
      };
    }

    connect();

    return () => {
      unmounted.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingInterval.current) clearInterval(pingInterval.current);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = () => ws.close();
        } else {
          ws.close();
        }
      }
    };
  }, [workspaceId, appendLine]);

  return (
    <div className="console">
      <div className="console-head">
        <span className="console-title">Console</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: connected ? "#4caf73" : "#e05252",
              display: "inline-block",
            }}
          />
          <button
            onClick={() => setLines([])}
            className="linkbtn linkbtn-light"
            style={{ fontSize: 12 }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="console-body">
        {lines.length === 0 && (
          <div className="console-empty">Agent output will stream here.</div>
        )}
        {lines.map((line, i) => (
          <div key={i} className={lineClass(line.type)}>
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
