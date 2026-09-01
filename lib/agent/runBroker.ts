// Decouples a live agent run from any single HTTP request. A run is started once and driven in a
// detached loop; its events are buffered and fanned out to any number of subscribers (the SSE
// stream of whoever is currently watching). This is what lets a user close their tab mid-run and,
// on return, re-attach and watch the same run continue live — and why a brief disconnect no longer
// kills anything. Only an explicit stop() ends a run.
//
// One run at a time per (workspace, conversation). The buffer holds every event since the run
// started, so a late subscriber first replays the buffer (catching up) and then receives live
// events. Conversations persist only at run end, so the committed history and this buffer never
// overlap — the reconnect path reconstructs from "saved history before the run" + "this buffer".
import type { BaseMessage } from "@langchain/core/messages";
import { runAgent, type AgentEvent } from "./runner";
import type { RunAgentOptions } from "./runner";
import { noteRunError } from "./messageSerialization";
import { getStore, getContainers, getVersioning } from "../infra/services";
import { finishUsageSession, recordRunError, recordTurnUsage, startUsageSession } from "@/lib/usage/record";
import type { RunErrorRecord, SessionOrigin, SessionStatus } from "@/lib/usage/types";
import { contentToParagraphs } from "@/lib/transcript/content";
import * as conversations from "@/lib/conversations/store";
import { createLogger } from "../infra/logger";
import { createWorkspaceRunTimeout, USER_STOPPED_CONVERSATION_MESSAGE } from "./runTimeout";
import {
  executionCapacity,
  ExecutionCapacityReachedError,
  type ExecutionCapacityGate,
  type ExecutionCapacitySnapshot,
} from "./executionCapacity";

const log = createLogger("runBroker");

type Subscriber = (event: AgentEvent) => void;

interface RunSession {
  workspaceId: string;
  conversationId: string;
  userInput: string;
  buffer: AgentEvent[];
  subscribers: Set<Subscriber>;
  abort: AbortController;
  status: "running" | "done";
}

// How long a finished run lingers so a client that reconnects right at the end still replays the
// final events before the session is evicted.
const DONE_LINGER_MS = 30_000;

type AgentRunStatus = SessionStatus;

function statusFromEvent(current: AgentRunStatus, event: AgentEvent): AgentRunStatus {
  if (event.type === "limit_reached") return "limit_reached";
  if (event.type !== "error") return current;
  if (event.code === "TIMEOUT") return "timeout";
  if (event.code === "CANCELLED") return "cancelled";
  return "failed";
}

const g = global as typeof global & { _runBroker?: Map<string, RunSession> };
if (!g._runBroker) g._runBroker = new Map();
const sessions = g._runBroker;

const key = (workspaceId: string, conversationId: string) => `${workspaceId}::${conversationId}`;

export interface StartRunParams {
  workspaceId: string;
  workspaceName: string;
  workspaceDir: string;
  conversationId: string;
  /** The conversation's live history (system prompt already set). The runner appends to it. */
  messages: BaseMessage[];
  userInput: string;
  maxIterations: number;
  maxRunMinutes: number;
  /** Explicit initiation path for dashboard provenance. */
  origin?: SessionOrigin;
  // Test seams — production defaults wire the real runner, services, usage, and persistence.
  run?: typeof runAgent;
  runOptions?: Partial<RunAgentOptions>;
  onTurnUsage?: (sessionId: string, event: Extract<AgentEvent, { type: "turn_usage" }>) => void;
  onRunError?: (sessionId: string, error: RunErrorRecord) => void;
  onPersist?: () => void;
  /** Test seam; production uses the process-wide execution ceiling. */
  capacity?: ExecutionCapacityGate;
}

/**
 * Start a run for a conversation, or report that one is already running. The actual run proceeds
 * in the background regardless of who (if anyone) is subscribed.
 */
export function startRun(params: StartRunParams): {
  alreadyRunning: boolean;
  capacityReached?: ExecutionCapacitySnapshot;
} {
  const k = key(params.workspaceId, params.conversationId);
  const existing = sessions.get(k);
  if (existing && existing.status === "running") return { alreadyRunning: true };

  const session: RunSession = {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    userInput: params.userInput,
    buffer: [],
    subscribers: new Set(),
    abort: new AbortController(),
    status: "running",
  };
  const run = params.run ?? runAgent;
  const sessionId = crypto.randomUUID();
  const origin = params.origin ?? "chat";
  const recordUsage = params.onTurnUsage ?? ((sid, event) => recordTurnUsage(sid, event));
  const recordError = params.onRunError ?? ((sid, error) => recordRunError(sid, error));
  const persist = params.onPersist ?? (() => conversations.persist(params.workspaceId, params.conversationId));

  const runTimeout = createWorkspaceRunTimeout(
    { id: params.workspaceId, name: params.workspaceName, maxRunMinutes: params.maxRunMinutes },
    [session.abort.signal, params.runOptions?.signal],
  );
  const runOptions: RunAgentOptions = {
    maxIterations: params.maxIterations,
    store: getStore(),
    containers: getContainers(),
    versioning: getVersioning(),
    ...params.runOptions,
    // A caller cannot replace the cache scope: it must follow the persisted history being sent.
    conversationId: params.conversationId,
    signal: runTimeout.signal,
  };
  const leading = params.messages[0];
  const systemPrompt = leading?._getType() === "system" ? contentToParagraphs(leading.content) : "";
  startUsageSession({
    id: sessionId,
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName,
    conversationId: params.conversationId,
    origin,
    userInput: params.userInput,
    systemPrompt,
  });
  const capacity = params.capacity ?? executionCapacity;
  const executionSlot = capacity.tryAcquire();
  if (!executionSlot) {
    runTimeout.dispose();
    const snapshot = capacity.snapshot();
    log.warn(
      {
        event: "agent_execution_capacity_reached",
        outcome: "run_not_started",
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        origin: params.origin,
        activeAgentRuns: snapshot.active,
        maxAgentRuns: snapshot.limit,
      },
      "agent run rejected at execution capacity",
    );
    finishUsageSession(sessionId, "failed", {
      code: "CAPACITY_REACHED",
      message: "The agent execution capacity was reached before this session could start.",
    });
    return { alreadyRunning: false, capacityReached: snapshot };
  }
  const capacityAtStart = capacity.snapshot();
  sessions.set(k, session);
  const startedAt = Date.now();
  log.info(
    {
      event: "agent_run_started",
      outcome: "run_started",
      sessionId,
      conversationId: params.conversationId,
      workspaceId: params.workspaceId,
      origin,
      maxIterations: params.maxIterations,
      maxRunMinutes: params.maxRunMinutes,
      activeAgentRuns: capacityAtStart.active,
      maxAgentRuns: capacityAtStart.limit,
    },
    "agent run started",
  );
  // Keep the container warm for the whole run (paired with noteRunEnd in the finally below), so a
  // long model turn between tool calls can never let the idle reaper stop it mid-run.
  getContainers().noteRunStart(params.workspaceId);

  // Detached: not awaited, not tied to any request. Errors are surfaced as events by runAgent.
  void (async () => {
    let sentDone = false;
    let recordedError = false;
    let terminalStatus: AgentRunStatus = "success";
    const publish = (event: AgentEvent) => {
      terminalStatus = statusFromEvent(terminalStatus, event);
      session.buffer.push(event);
      for (const sub of session.subscribers) {
        try {
          sub(event);
        } catch (err) {
          log.warn({ err }, "subscriber threw");
        }
      }
      if (event.type === "turn_usage") recordUsage(sessionId, event);
      if (event.type === "error" && !recordedError) {
        recordedError = true;
        recordError(sessionId, { code: event.code, message: event.message });
        // Also onto the history persisted below, so the reason is still there when the conversation
        // is re-opened — or opened for the first time, for a run started through the API.
        noteRunError(params.messages, event.message);
      }
      if (event.type === "done") sentDone = true;
    };
    const publishTimeout = () => {
      if (sentDone) return;
      terminalStatus = "timeout";
      log.warn(
        {
          event: "agent_run_timed_out",
          outcome: "run_ended",
          sessionId,
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          origin,
          maxRunMinutes: params.maxRunMinutes,
          durationMs: Date.now() - startedAt,
        },
        "agent run timed out",
      );
      publish({ type: "error", code: "TIMEOUT", message: runTimeout.error.message });
      publish({ type: "done" });
    };
    const publishUserStop = () => {
      if (sentDone) return;
      terminalStatus = "cancelled";
      log.info(
        {
          event: "agent_run_cancelled",
          outcome: "run_ended",
          sessionId,
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          origin,
          durationMs: Date.now() - startedAt,
        },
        "agent run cancelled by user",
      );
      publish({ type: "error", code: "CANCELLED", message: USER_STOPPED_CONVERSATION_MESSAGE });
      publish({ type: "done" });
    };
    // Last resort for a run that died without saying so. runAgent turns everything raised inside
    // its loop into an error event, but whatever throws *before* that loop — loading the workspace
    // config, building the model for a selection the provider no longer accepts — escapes to the
    // catch below. That used to log and stop there: no error event, no `done`, so the stream hung
    // open and the conversation showed a prompt that was apparently ignored.
    const publishFailure = (message: string, status: AgentRunStatus = "failed") => {
      if (sentDone) return;
      publish({ type: "error", message });
      publish({ type: "done" });
      // After the publishes: an uncoded error event would otherwise mark every one of these "failed".
      terminalStatus = status;
    };

    try {
      for await (const event of run(
        params.messages,
        params.userInput,
        params.workspaceDir,
        params.workspaceId,
        runOptions,
      )) {
        // Replace provider-specific abort errors with one stable workspace timeout event.
        if (runTimeout.didTimeout() && event.type === "error") continue;
        if (runTimeout.didTimeout() && event.type === "done") {
          publishTimeout();
          break;
        }
        // Explicit Stop uses the same low-level AbortSignal as provider cancellation. Hide the
        // provider's AbortError and expose one stable, user-facing explanation instead.
        if (session.abort.signal.aborted && event.type === "error") continue;
        if (session.abort.signal.aborted && event.type === "done") {
          publishUserStop();
          break;
        }
        publish(event);
        if (event.type === "done") break;
      }
    } catch (err) {
      if (runTimeout.didTimeout()) {
        terminalStatus = "timeout";
      } else if (session.abort.signal.aborted) {
        terminalStatus = "cancelled";
      } else {
        log.error(
          {
            event: "detached_agent_run_failed",
            outcome: "run_ended",
            err,
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
          },
          "detached run failed",
        );
        publishFailure(
          `This run stopped on an unexpected error and could not continue: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      if (runTimeout.didTimeout() && !sentDone) publishTimeout();
      else if (session.abort.signal.aborted && !sentDone) publishUserStop();
      // A run that returned without `done` and without an error: nothing above claimed it, so it
      // would otherwise be recorded as `incomplete` and shown as nothing at all.
      else if (!sentDone) {
        log.error(
          {
            event: "agent_run_ended_incomplete",
            outcome: "run_ended",
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
          },
          "run ended without finishing",
        );
        publishFailure("This run ended without finishing and without reporting why.", "incomplete");
      }
      runTimeout.dispose();
      session.status = "done";
      executionSlot.release();
      // Run over: hand the container back to the task-aware idle reaper.
      getContainers().noteRunEnd(params.workspaceId);
      const capacityAtEnd = capacity.snapshot();
      try {
        persist();
      } catch (err) {
        log.error(
          {
            event: "conversation_run_persist_failed",
            outcome: "run_history_not_persisted",
            err,
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
          },
          "persist on run end failed",
        );
      }
      finishUsageSession(sessionId, terminalStatus);
      log.info(
        {
          event: "agent_run_completed",
          outcome: "run_ended",
          sessionId,
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          origin,
          status: terminalStatus,
          durationMs: Date.now() - startedAt,
          activeAgentRuns: capacityAtEnd.active,
          maxAgentRuns: capacityAtEnd.limit,
        },
        "agent run completed",
      );
      setTimeout(() => {
        // Only evict if no newer run took this slot.
        if (sessions.get(k) === session) sessions.delete(k);
      }, DONE_LINGER_MS);
    }
  })();

  return { alreadyRunning: false };
}

/**
 * A producer-driven run: its events are generated elsewhere rather than by a detached runAgent
 * loop. executeSkill uses this for agent-to-agent calls — it has to drive the callee's runAgent
 * itself (it needs the streamed text for output validation and correction retries), but the
 * callee's run must still be live-subscribable so the callee's own conversation tab can attach and
 * watch it (otherwise a caller deep-linking into the callee session sees a blank, "stuck" UI while
 * the run only logs to the console and persists at the very end).
 */
export interface ExternalRun {
  /** Buffer + fan out one event to subscribers, exactly as the detached loop in startRun does. */
  publish: (event: AgentEvent) => void;
  /** Mark the run done and schedule eviction. Persist the conversation BEFORE calling this so a
   *  client reconnecting at the end replays from consistent committed history. */
  finish: (status?: AgentRunStatus) => void;
  /** Fires when stop() is called for this conversation. The producer (executeSkill) must thread
   *  this into the callee's runner so a Stop on the callee's own tab actually halts it — otherwise
   *  the session's AbortController has no listener and stop() is a no-op. */
  signal: AbortSignal;
}

/**
 * Register a producer-driven run for a conversation. Returns null if a run is already live for it
 * (mirrors startRun's one-run-per-conversation rule). The caller publishes each event and calls
 * finish() when the whole call — including any correction retries — has completed.
 */
export function startExternalRun(
  workspaceId: string,
  conversationId: string,
  userInput: string,
  opts: {
    sessionId?: string;
    workspaceName?: string;
    origin?: SessionOrigin;
    systemPrompt?: string;
    capacity?: ExecutionCapacityGate;
  } = {},
): ExternalRun | null {
  const k = key(workspaceId, conversationId);
  const existing = sessions.get(k);
  if (existing && existing.status === "running") return null;

  const session: RunSession = {
    workspaceId,
    conversationId,
    userInput,
    buffer: [],
    subscribers: new Set(),
    abort: new AbortController(),
    status: "running",
  };
  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const origin = opts.origin ?? "agent";
  startUsageSession({
    id: sessionId,
    workspaceId,
    workspaceName: opts.workspaceName ?? workspaceId,
    conversationId,
    origin,
    userInput,
    systemPrompt: opts.systemPrompt ?? "",
  });
  const capacity = opts.capacity ?? executionCapacity;
  const executionSlot = capacity.tryAcquire();
  if (!executionSlot) {
    const snapshot = capacity.snapshot();
    log.warn(
      {
        event: "agent_execution_capacity_reached",
        outcome: "run_not_started",
        workspaceId,
        conversationId,
        origin,
        activeAgentRuns: snapshot.active,
        maxAgentRuns: snapshot.limit,
      },
      "external agent run rejected at execution capacity",
    );
    finishUsageSession(sessionId, "failed", {
      code: "CAPACITY_REACHED",
      message: "The agent execution capacity was reached before this session could start.",
    });
    throw new ExecutionCapacityReachedError(snapshot, { workspaceId, conversationId, origin });
  }
  const capacityAtStart = capacity.snapshot();

  sessions.set(k, session);
  const startedAt = Date.now();
  let terminalStatus: AgentRunStatus = "success";
  log.info(
    {
      event: "agent_run_started",
      outcome: "run_started",
      sessionId,
      conversationId,
      workspaceId,
      origin,
      activeAgentRuns: capacityAtStart.active,
      maxAgentRuns: capacityAtStart.limit,
    },
    "agent run started",
  );
  getContainers().noteRunStart(workspaceId);

  return {
    publish: (event) => {
      terminalStatus = statusFromEvent(terminalStatus, event);
      session.buffer.push(event);
      for (const sub of session.subscribers) {
        try {
          sub(event);
        } catch (err) {
          log.warn({ err }, "subscriber threw");
        }
      }
    },
    finish: (status) => {
      if (session.status === "done") return;
      session.status = "done";
      executionSlot.release();
      getContainers().noteRunEnd(workspaceId);
      const capacityAtEnd = capacity.snapshot();
      if (status) terminalStatus = status;
      if (!session.buffer.some((event) => event.type === "done") && terminalStatus === "success") {
        terminalStatus = "incomplete";
      }
      finishUsageSession(sessionId, terminalStatus);
      log.info(
        {
          event: "agent_run_completed",
          outcome: "run_ended",
          sessionId,
          conversationId,
          workspaceId,
          origin,
          status: terminalStatus,
          durationMs: Date.now() - startedAt,
          activeAgentRuns: capacityAtEnd.active,
          maxAgentRuns: capacityAtEnd.limit,
        },
        "agent run completed",
      );
      setTimeout(() => {
        if (sessions.get(k) === session) sessions.delete(k);
      }, DONE_LINGER_MS);
    },
    signal: session.abort.signal,
  };
}

export interface Subscription {
  /** Every event so far — re-emit these first, then live events arrive via the callback. */
  replay: AgentEvent[];
  /** The message that started this run, for rendering the user's bubble on reconnect. */
  userInput: string;
  status: "running" | "done";
  unsubscribe: () => void;
}

/**
 * Attach to a run. Returns null if no run exists for this conversation. The replay snapshot and the
 * subscriber registration happen in one synchronous step, so no event can slip through the gap.
 */
export function subscribe(workspaceId: string, conversationId: string, cb: Subscriber): Subscription | null {
  const session = sessions.get(key(workspaceId, conversationId));
  if (!session) return null;
  const replay = [...session.buffer];
  session.subscribers.add(cb);
  return {
    replay,
    userInput: session.userInput,
    status: session.status,
    unsubscribe: () => session.subscribers.delete(cb),
  };
}

export function isRunning(workspaceId: string, conversationId: string): boolean {
  return sessions.get(key(workspaceId, conversationId))?.status === "running";
}

/** The in-flight run's starting message, so a reconnecting client can render the user's bubble. */
export function peekUserInput(workspaceId: string, conversationId: string): string | null {
  const session = sessions.get(key(workspaceId, conversationId));
  return session && session.status === "running" ? session.userInput : null;
}

/** Conversation ids with a currently-running agent, for annotating the conversation list. */
export function runningConversationIds(workspaceId: string): string[] {
  const ids: string[] = [];
  for (const session of sessions.values()) {
    if (session.workspaceId === workspaceId && session.status === "running") ids.push(session.conversationId);
  }
  return ids;
}

/** Explicit stop: aborts the run, which the runner observes and exits cleanly (history stays valid). */
export function stop(workspaceId: string, conversationId: string): boolean {
  const session = sessions.get(key(workspaceId, conversationId));
  if (!session || session.status !== "running") return false;
  session.abort.abort();
  return true;
}
