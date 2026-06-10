// Real-time console panel. Delegates WebSocket lifecycle to useConsoleSocket.
"use client";

import { useEffect, useRef } from "react";
import { useConsoleSocket, type ConsoleLine } from "@/lib/hooks/useConsoleSocket";

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
  const { lines, connected, clearLines } = useConsoleSocket(workspaceId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="flex flex-col bg-console-bg min-h-0 overflow-hidden flex-1">
      <div className="flex items-center justify-between px-4 min-h-[44px] box-border bg-[#181818] text-[#d0d0d0] text-[13px] border-t border-[#2a2a2a] flex-shrink-0">
        <span className="font-medium tracking-[.02em]">Console</span>
        <div className="flex items-center gap-2.5">
          <span
            className="w-[7px] h-[7px] rounded-full inline-block"
            style={{ background: connected ? "#4caf73" : "#e05252" }}
          />
          <button onClick={clearLines} className="linkbtn" style={{ fontSize: 12 }}>
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
