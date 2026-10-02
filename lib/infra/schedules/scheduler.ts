// In-process tick loop (started from server.ts) firing each due schedule as a fresh, request-detached
// conversation. No missed-run catch-up: boot recomputes every nextRunAt to the first slot after now.
import { getStore } from "../services";
import { createLogger } from "../logger";
import { globalSingleton } from "../globalSingleton";
import * as broker from "../../agent/runBroker";
import { ExecutionCapacityReachedError } from "../../agent/executionCapacity";
import { startWorkspaceRun } from "@/lib/operations/agent/run";
import { listAll, getSchedule, setNextRunAt, recordRun } from "./scheduleStore";
import { nextRunIso, endBound } from "@/lib/schedules/nextRun";
import type { LastRun, RunStatus, ScheduleEntry } from "@/lib/schedules/types";
import { AppError } from "@/lib/errors/appError";

const log = createLogger("scheduler");

const DEFAULT_TICK_MS = 30_000;
const ERROR_MAX = 280;

type SchedulerState = { timer: NodeJS.Timeout | null };
const state = globalSingleton<SchedulerState>("schedulerState", () => ({ timer: null }));
// Workspace ids with a run in flight. Tracked here, not by the broker: every fire uses a fresh
// conversation id, so the broker's per-conversation guard would never see the previous run.
const inflight = globalSingleton<Set<string>>("schedulerInflight", () => new Set());
// A completed run must not fire again merely because its outcome could not reach disk.
const pendingOutcomes = globalSingleton<Map<string, LastRun>>("schedulerPendingOutcomes", () => new Map());

// scheduleStore already logs a failed write with full context, so this keeps it from escaping into
// the broker subscriber or being logged a second, vaguer time.
function recordRunSafely(workspaceId: string, run: LastRun, nextRunAt: string | null): void {
  try {
    recordRun(workspaceId, run, nextRunAt);
    pendingOutcomes.delete(workspaceId);
  } catch {
    pendingOutcomes.set(workspaceId, run);
    // Already logged as schedule_store_save_failed with workspace, schedule and operation context.
  }
}

function fire(entry: ScheduleEntry, now: Date): void {
  const ws = getStore().getWorkspace(entry.workspaceId);
  if (!ws) {
    log.warn({ workspaceId: entry.workspaceId }, "schedule fire skipped — workspace not found");
    // Advance so a deleted workspace's schedule doesn't re-attempt every tick.
    setNextRunAt(entry.workspaceId, nextRunIso(entry, now));
    return;
  }

  inflight.add(entry.workspaceId);

  let conversationId: string;
  try {
    const receipt = startWorkspaceRun(entry.workspaceId, {
      prompt: entry.prompt,
      origin: "scheduled",
      // Keep scheduled sessions named the same way as user-created ones (short conversation id),
      // so each run has an immediately visible, stable identifier in the switcher.
      conversation: { mode: "create" },
    });
    if (!receipt) {
      log.warn({ workspaceId: entry.workspaceId }, "schedule fire skipped — workspace not found");
      inflight.delete(entry.workspaceId);
      setNextRunAt(entry.workspaceId, nextRunIso(entry, now));
      return;
    }
    conversationId = receipt.conversationId;
    if (!receipt.started) {
      log.info(
        { workspaceId: ws.id, conversationId, scheduleId: entry.id },
        "schedule fire skipped — run already in progress",
      );
      inflight.delete(entry.workspaceId);
      setNextRunAt(entry.workspaceId, nextRunIso(entry, now));
      return;
    }
    log.info({ workspaceId: ws.id, conversationId, scheduleId: entry.id }, "schedule fired");
  } catch (err) {
    log.error(
      {
        event: "schedule_fire_start_failed",
        outcome: "run_not_started",
        err,
        workspaceId: ws.id,
        scheduleId: entry.id,
      },
      "schedule fire failed to start",
    );
    inflight.delete(entry.workspaceId);
    // A capacity refusal has already written itself into the conversation it names.
    const refusedIn = err instanceof ExecutionCapacityReachedError ? err.conversationId : undefined;
    recordRunSafely(
      entry.workspaceId,
      {
        at: now.toISOString(),
        status: "error",
        ...(refusedIn ? { conversationId: refusedIn } : {}),
        error: (err instanceof AppError ? err.message : String(err)).slice(0, ERROR_MAX),
      },
      nextRunIso(entry, new Date()),
    );
    return;
  }

  // Capture the run outcome for the "last run" status, then advance the next-run pointer.
  let error: string | undefined;
  let errored = false;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    inflight.delete(entry.workspaceId);
    const status: RunStatus = errored ? "error" : "ok";
    // Recompute from the latest stored schedule in case it was edited mid-run.
    const latest = getSchedule(entry.workspaceId) ?? entry;
    recordRunSafely(
      entry.workspaceId,
      {
        at: new Date().toISOString(),
        status,
        conversationId,
        ...(errored ? { error: (error || "run failed").slice(0, ERROR_MAX) } : {}),
      },
      nextRunIso(latest, new Date()),
    );
    sub?.unsubscribe();
  };

  const sub = broker.subscribe(ws.id, conversationId, (event) => {
    if (event.type === "error") {
      errored = true;
      error ??= event.message;
    } else if (event.type === "done") finish();
  });

  // subscribe returns buffered events separately; an immediate failure may already be there.
  for (const event of sub?.replay ?? []) {
    if (event.type === "error") {
      errored = true;
      error ??= event.message;
    }
  }

  // The run may have already finished between startRun and subscribe (e.g. an immediate error).
  if (!sub || sub.status === "done") finish();
}

function tick(): void {
  const now = new Date();
  let entries: ScheduleEntry[];
  try {
    entries = listAll();
  } catch (err) {
    log.error(
      { event: "schedule_scan_failed", outcome: "tick_aborted", err },
      "failed to read schedules for scheduler tick",
    );
    return;
  }

  const workspaceIds = new Set(entries.map((entry) => entry.workspaceId));
  for (const id of pendingOutcomes.keys()) if (!workspaceIds.has(id)) pendingOutcomes.delete(id);

  // Isolate every entry: one malformed schedule must not abort later due schedules or escape the
  // interval callback and trigger the process-level uncaughtException handler.
  for (const entry of entries) {
    try {
      const pending = pendingOutcomes.get(entry.workspaceId);
      if (pending) {
        recordRunSafely(entry.workspaceId, pending, nextRunIso(entry, now));
        continue;
      }
      if (!entry.enabled || !entry.nextRunAt) continue;
      if (inflight.has(entry.workspaceId)) continue;
      const due = new Date(entry.nextRunAt).getTime();
      if (!Number.isFinite(due) || due > now.getTime()) continue;
      const end = endBound(entry);
      if (end && now.getTime() >= end.toMillis()) {
        setNextRunAt(entry.workspaceId, null);
        continue;
      }
      fire(entry, now);
    } catch (err) {
      log.error(
        {
          event: "schedule_tick_entry_failed",
          outcome: "schedule_skipped",
          err,
          workspaceId: entry.workspaceId,
          scheduleId: entry.id,
        },
        "scheduler tick failed for schedule",
      );
    }
  }
}

/**
 * Start the tick loop. Idempotent. Recomputes every schedule's nextRunAt to a strictly-future
 * instant first, so a restart never replays runs that were due while the server was down.
 */
export function startScheduler(): void {
  if (state.timer) return;
  const now = new Date();
  for (const entry of listAll()) {
    setNextRunAt(entry.workspaceId, nextRunIso(entry, now));
  }
  const tickMs = parseInt(process.env.SCHEDULE_TICK_MS ?? String(DEFAULT_TICK_MS), 10) || DEFAULT_TICK_MS;
  state.timer = setInterval(tick, tickMs);
  state.timer.unref?.();
  log.info({ tickMs }, "scheduler started");
}

export function stopScheduler(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  log.info("scheduler stopped");
}

// Exported for tests to drive a single scan deterministically.
export { tick as _tick };
