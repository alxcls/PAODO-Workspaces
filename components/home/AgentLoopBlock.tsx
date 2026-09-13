"use client";

import { useState, useEffect } from "react";
import type { AsyncResource } from "@/lib/client/hooks/useAsyncResource";
import type { WorkspaceDetails } from "@/lib/client/hooks/useWorkspaceDetails";
import { AsyncState } from "@/components/shared/AsyncState";
import { isBoundedIntegerDraft } from "@/lib/client/integerDraft";
import { confirmedValues } from "@/lib/client/workspaceReceipt";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_RUN_MINUTES,
  MAX_MAX_ITERATIONS,
  MAX_MAX_RUN_MINUTES,
  MIN_MAX_ITERATIONS,
  MIN_MAX_RUN_MINUTES,
} from "@/lib/workspace/limits";

const LABEL_WIDTH = 120;
const CONTROL_WIDTH = 80;
const CONTROL_GAP = 8;

export default function AgentLoopBlock({
  wsId,
  workspace,
}: {
  wsId: string;
  workspace: AsyncResource<WorkspaceDetails>;
}) {
  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Agent Loop</span>
        <span className="text-xs text-text-3 ml-2">Run safety limits</span>
      </div>
      {workspace.data ? (
        <AgentLoopForm key={wsId} wsId={wsId} initial={workspace.data} />
      ) : (
        <AsyncState
          loading={workspace.loading}
          error={workspace.error}
          onRetry={workspace.reload}
          errorLabel="Couldn’t load the agent loop limits."
        />
      )}
    </div>
  );
}

function AgentLoopForm({ wsId, initial }: { wsId: string; initial: WorkspaceDetails }) {
  const [confirmed, setConfirmed] = useState<{ source: WorkspaceDetails; iterations: number; minutes: number } | null>(
    null,
  );
  const iterations =
    confirmed?.source === initial ? confirmed.iterations : (initial.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const minutes =
    confirmed?.source === initial ? confirmed.minutes : (initial.maxRunMinutes ?? DEFAULT_MAX_RUN_MINUTES);
  const [draft, setDraft] = useState<{ iterations: string; minutes: string } | null>(null);
  const iterationsDraft = draft?.iterations ?? String(iterations);
  const minutesDraft = draft?.minutes ?? String(minutes);
  const setIterationsDraft = (value: string) =>
    setDraft((current) => ({
      iterations: value,
      minutes: current?.minutes ?? String(minutes),
    }));
  const setMinutesDraft = (value: string) =>
    setDraft((current) => ({
      iterations: current?.iterations ?? String(iterations),
      minutes: value,
    }));

  useEffect(() => {
    if (iterationsDraft.trim() === "" || minutesDraft.trim() === "") return;

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
        if (controller.signal.aborted) return;
        setConfirmed({
          source: initial,
          iterations: maxIterations ?? nextIterations,
          minutes: maxRunMinutes ?? nextMinutes,
        });
        setDraft(null);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
      }
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [iterations, iterationsDraft, minutes, minutesDraft, wsId, initial]);

  return (
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
  );
}
