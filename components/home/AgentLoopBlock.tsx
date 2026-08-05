"use client";

import { useState, useEffect, useRef } from "react";
import { isBoundedIntegerDraft } from "@/lib/client/integerDraft";
import { confirmedValues } from "@/lib/client/workspaceReceipt";
import {
  MAX_MAX_ITERATIONS,
  MAX_MAX_RUN_MINUTES,
  MIN_MAX_ITERATIONS,
  MIN_MAX_RUN_MINUTES,
} from "@/lib/workspace/limits";

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

    const nextIterations = Number(iterationsDraft);
    const nextMinutes = Number(minutesDraft);
    const valid =
      Number.isInteger(nextIterations) &&
      nextIterations >= MIN_MAX_ITERATIONS &&
      nextIterations <= MAX_MAX_ITERATIONS &&
      Number.isInteger(nextMinutes) &&
      nextMinutes >= MIN_MAX_RUN_MINUTES &&
      nextMinutes <= MAX_MAX_RUN_MINUTES;
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
        const confirmedIterations = maxIterations ?? nextIterations;
        const confirmedMinutes = maxRunMinutes ?? nextMinutes;
        setIterations(confirmedIterations);
        setIterationsDraft(String(confirmedIterations));
        setMinutes(confirmedMinutes);
        setMinutesDraft(String(confirmedMinutes));
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
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            title={`Whole number from ${MIN_MAX_ITERATIONS} to ${MAX_MAX_ITERATIONS}`}
            className="input input-sm flex-none text-center text-text"
            style={{ width: CONTROL_WIDTH }}
            value={iterationsDraft}
            onChange={(e) => {
              if (isBoundedIntegerDraft(e.target.value, MIN_MAX_ITERATIONS, MAX_MAX_ITERATIONS)) {
                setIterationsDraft(e.target.value);
              }
            }}
            onBlur={() => {
              if (iterationsDraft === "") setIterationsDraft(String(iterations));
            }}
          />
          <label htmlFor={`max-tool-calls-${wsId}`} className="text-xs text-text-3" style={{ width: LABEL_WIDTH }}>
            Max tool calls
          </label>
        </div>
        <div className="flex items-center" style={{ gap: CONTROL_GAP }}>
          <input
            id={`timeout-minutes-${wsId}`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            title={`Whole number from ${MIN_MAX_RUN_MINUTES} to ${MAX_MAX_RUN_MINUTES}`}
            className="input input-sm flex-none text-center text-text"
            style={{ width: CONTROL_WIDTH }}
            value={minutesDraft}
            onChange={(e) => {
              if (isBoundedIntegerDraft(e.target.value, MIN_MAX_RUN_MINUTES, MAX_MAX_RUN_MINUTES)) {
                setMinutesDraft(e.target.value);
              }
            }}
            onBlur={() => {
              if (minutesDraft === "") setMinutesDraft(String(minutes));
            }}
          />
          <label htmlFor={`timeout-minutes-${wsId}`} className="text-xs text-text-3" style={{ width: LABEL_WIDTH }}>
            Timeout in minutes
          </label>
        </div>
      </div>
    </div>
  );
}
