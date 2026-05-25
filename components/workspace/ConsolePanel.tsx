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
  const base = "whitespace-pre-wrap break-words";
  switch (type) {
    case "tool":   return `${base} text-console-call`;
    case "stderr": return `${base} text-console-err`;
    case "info":   return `${base} text-console-res`;
    default:       return `${base} text-console-fg`;
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
    <div className="flex flex-col bg-console-bg min-h-0 overflow-hidden flex-1">
      <div className="flex items-center justify-between px-4 min-h-[44px] box-border bg-[#181818] text-[#d0d0d0] text-[13px] border-t border-[#2a2a2a] flex-shrink-0">
        <span className="font-medium tracking-[.02em]">Console</span>
        <div className="flex items-center gap-2.5">
          <span
            className="w-[7px] h-[7px] rounded-full inline-block"
            style={{ background: connected ? "#4caf73" : "#e05252" }}
          />
          <button onClick={() => setLines([])} className="linkbtn" style={{ fontSize: 12 }}>
            Clear
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-4 pt-2 pb-3 font-mono text-[12.5px] leading-[1.6] text-console-fg">
        {lines.length === 0 && (
          <div className="text-[#888] italic">Agent output will stream here.</div>
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
