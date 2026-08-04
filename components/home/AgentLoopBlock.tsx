"use client";

import { useState, useEffect, useRef } from "react";
import { confirmedValues } from "@/lib/client/workspaceReceipt";

const LABEL_WIDTH = 120;
const CONTROL_WIDTH = 80;
const CONTROL_GAP = 8;

export default function AgentLoopBlock({ wsId }: { wsId: string }) {
  const [iterations, setIterations] = useState(30);
  const [iterationsDraft, setIterationsDraft] = useState("30");
  const [minutes, setMinutes] = useState(5);
  const [minutesDraft, setMinutesDraft] = useState("5");
  const loadedForWsId = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadedForWsId.current = null;
    fetch(`/api/workspaces/${wsId}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { maxIterations?: number; maxRunMinutes?: number }) => {
        if (controller.signal.aborted) return;
        const nextIterations = d.maxIterations ?? 30;
        const nextMinutes = d.maxRunMinutes ?? 5;
        loadedForWsId.current = wsId;
        setIterations(nextIterations);
        setIterationsDraft(String(nextIterations));
        setMinutes(nextMinutes);
        setMinutesDraft(String(nextMinutes));
      })
      .catch(() => {});

    return () => controller.abort();
  }, [wsId]);

  useEffect(() => {
    if (loadedForWsId.current !== wsId || iterationsDraft.trim() === "" || minutesDraft.trim() === "") return;

    const nextIterations = Math.floor(Number(iterationsDraft));
    const nextMinutes = Math.floor(Number(minutesDraft));
    const valid =
      Number.isFinite(nextIterations) &&
      nextIterations >= 1 &&
      nextIterations <= 500 &&
      Number.isFinite(nextMinutes) &&
      nextMinutes >= 1 &&
      nextMinutes <= 1440;
    if (!valid || (nextIterations === iterations && nextMinutes === minutes)) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/workspaces/${wsId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxIterations: nextIterations, maxRunMinutes: nextMinutes }),
          signal: controller.signal,
        });
        if (!response.ok || controller.signal.aborted) return;
        const { maxIterations, maxRunMinutes } = await confirmedValues(response);
        setIterations(maxIterations ?? nextIterations);
        setMinutes(maxRunMinutes ?? nextMinutes);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
      }
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [iterations, iterationsDraft, minutes, minutesDraft, wsId]);

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Agent Loop</span>
        <span className="text-xs text-text-3 ml-2">Run safety limits</span>
      </div>
      <div className="flex flex-col items-start gap-2">
        <div className="flex items-center" style={{ gap: CONTROL_GAP }}>
          <input
            id={`max-tool-calls-${wsId}`}
            type="number"
            min={1}
            max={500}
            className="input input-sm flex-none text-center text-text"
            style={{ width: CONTROL_WIDTH }}
            value={iterationsDraft}
            onChange={(e) => setIterationsDraft(e.target.value)}
          />
          <label htmlFor={`max-tool-calls-${wsId}`} className="text-xs text-text-3" style={{ width: LABEL_WIDTH }}>
            Max tool calls
          </label>
        </div>
        <div className="flex items-center" style={{ gap: CONTROL_GAP }}>
          <input
            id={`timeout-minutes-${wsId}`}
            type="number"
            min={1}
            max={1440}
            className="input input-sm flex-none text-center text-text"
            style={{ width: CONTROL_WIDTH }}
            value={minutesDraft}
            onChange={(e) => setMinutesDraft(e.target.value)}
          />
          <label htmlFor={`timeout-minutes-${wsId}`} className="text-xs text-text-3" style={{ width: LABEL_WIDTH }}>
            Timeout in minutes
          </label>
        </div>
      </div>
    </div>
  );
}
