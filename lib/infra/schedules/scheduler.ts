// In-process scheduler that fires workspace agent runs on their configured recurrence.
//
// A single tick loop (started once from server.ts) scans the schedule store and fires any schedule
// whose next-run instant has arrived. Each fire starts a fresh conversation and drives the agent
// through the run broker exactly like a user message would — the run is detached from any request,
// so no browser need be attached.
//
// Design notes:
//   - Reentrancy is tracked here (an in-memory set of in-flight workspace ids), NOT by the broker:
//     every fire uses a fresh conversation id, so the broker's own already-running guard (keyed on
//     workspace+conversation) can never catch a still-running prior run.
//   - No missed-run catch-up: on boot every schedule's nextRunAt is recomputed to the first
//     occurrence strictly after now, so slots that elapsed while the server was offline are skipped.
import { getStore } from "../services";
import { createLogger } from "../logger";
import { globalSingleton } from "../globalSingleton";
import * as broker from "../../agent/runBroker";
import * as conversations from "../../workspace/conversationStore";
import { buildSystemPrompt, buildPromptConfig } from "../../agent/systemPrompt";
import { buildWorkspacePromptInputs } from "../../agent/promptContext";
import { loadAgentConfig } from "../../agent/buildTools";
import { setSystemPrompt } from "../../agent/messageSerialization";
import { listAll, getSchedule, setNextRunAt, recordRun, type ScheduleEntry, type RunStatus } from "./scheduleStore";
import { computeNextRun } from "./nextRun";

const log = createLogger("scheduler");

const DEFAULT_TICK_MS = 30_000;
const SNIPPET_MAX = 280;

type SchedulerState = { timer: NodeJS.Timeout | null };
const state = globalSingleton<SchedulerState>("schedulerState", () => ({ timer: null }));
// Workspace ids with a scheduled run currently in flight — guards against overlapping fires.
const inflight = globalSingleton<Set<string>>("schedulerInflight", () => new Set());

/** Next-run ISO string for a schedule, or null if it is disabled or has passed its end bound. */
function nextRunIso(entry: ScheduleEntry, from: Date): string | null {
  if (!entry.enabled) return null;
  const next = computeNextRun(entry, from);
  return next ? next.toISOString() : null;
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
    // Keep scheduled sessions named the same way as user-created ones (short conversation id),
    // so each run has an immediately visible, stable identifier in the switcher.
    const conv = conversations.createConversation(ws.id, { kind: "scheduled" });
    conversationId = conv.id;
    const messages = conversations.getMessages(ws.id, conversationId) ?? [];
    const inputs = buildWorkspacePromptInputs(ws.id, ws.dir);
    setSystemPrompt(messages, buildSystemPrompt(ws.dir, buildPromptConfig(loadAgentConfig(ws.id)), inputs));
    broker.startRun({
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceDir: ws.dir,
      conversationId,
      messages,
      userInput: entry.prompt,
      maxIterations: ws.maxIterations,
      origin: "scheduled",
    });
    log.info({ workspaceId: ws.id, conversationId, scheduleId: entry.id }, "schedule fired");
  } catch (err) {
    log.error({ err, workspaceId: ws.id }, "schedule fire failed to start");
    inflight.delete(entry.workspaceId);
    recordRun(entry.workspaceId, {
      at: now.toISOString(),
      status: "error",
      snippet: String(err).slice(0, SNIPPET_MAX),
      nextRunAt: nextRunIso(entry, new Date()),
    });
    return;
  }

  // Capture the run outcome for the "last run" status, then advance the next-run pointer.
  let response = "";
  let errored = false;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    inflight.delete(entry.workspaceId);
    const status: RunStatus = errored ? "error" : "ok";
    const snippet = (response.trim() || (errored ? "run failed" : "")).slice(0, SNIPPET_MAX);
    // Recompute from the latest stored schedule in case it was edited mid-run.
    const latest = getSchedule(entry.workspaceId) ?? entry;
    recordRun(entry.workspaceId, {
      at: new Date().toISOString(),
      status,
      snippet,
      nextRunAt: nextRunIso(latest, new Date()),
    });
    sub?.unsubscribe();
  };

  const sub = broker.subscribe(ws.id, conversationId, (event) => {
    if (event.type === "token") response += event.content;
    else if (event.type === "error") {
      errored = true;
      if (!response) response = event.message;
    } else if (event.type === "done") finish();
  });

  // The run may have already finished between startRun and subscribe (e.g. an immediate error).
  if (!sub || sub.status === "done") finish();
}

function tick(): void {
  const now = new Date();
  for (const entry of listAll()) {
    if (!entry.enabled || !entry.nextRunAt) continue;
    if (inflight.has(entry.workspaceId)) continue;
    if (new Date(entry.nextRunAt).getTime() > now.getTime()) continue;
    fire(entry, now);
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
