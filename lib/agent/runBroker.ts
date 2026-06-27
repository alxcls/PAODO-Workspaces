// Decouples a live agent run from any single HTTP request. A run is started once and driven in a
// detached loop; its events are buffered and fanned out to any number of subscribers (the SSE
// stream of whoever is currently watching). This is what lets a user close their tab mid-run and,
// on return, re-attach and watch the same run continue live — and why a brief disconnect no longer
// kills anything. Only an explicit stop() ends a run.
//
// One run at a time per (workspace, conversation). The buffer holds every event since the run
// started, so a late subscriber first replays the buffer (catching up) and then receives live
// events. Conversations persist only at run end, so the on-disk history and this buffer never
// overlap — the reconnect path reconstructs from "saved history before the run" + "this buffer".
import type { BaseMessage } from "@langchain/core/messages";
import { runAgent, type AgentEvent } from "./runner";
import type { RunAgentOptions } from "./runner";
import { getStore, getContainers, getVersioning } from "../infra/services";
import { recordTurnUsage } from "../workspace/usageStore";
import * as conversations from "../workspace/conversationStore";
import { createLogger } from "../infra/logger";

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
  // Test seams — production defaults wire the real runner, services, usage, and persistence.
  run?: typeof runAgent;
  runOptions?: Partial<RunAgentOptions>;
  onTurnUsage?: (sessionId: string, event: Extract<AgentEvent, { type: "turn_usage" }>) => void;
  onPersist?: () => void;
}

/**
 * Start a run for a conversation, or report that one is already running. The actual run proceeds
 * in the background regardless of who (if anyone) is subscribed.
 */
export function startRun(params: StartRunParams): { alreadyRunning: boolean } {
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
  sessions.set(k, session);

  const run = params.run ?? runAgent;
  const sessionId = crypto.randomUUID();
  const recordUsage =
    params.onTurnUsage ??
    ((sid, event) =>
      recordTurnUsage({ sessionId: sid, conversationId: params.conversationId, workspaceId: params.workspaceId, workspaceName: params.workspaceName }, event));
  const persist = params.onPersist ?? (() => conversations.persist(params.workspaceId, params.conversationId));

  const runOptions: RunAgentOptions = {
    signal: session.abort.signal,
    maxIterations: params.maxIterations,
    store: getStore(),
    containers: getContainers(),
    versioning: getVersioning(),
    ...params.runOptions,
  };

  // Detached: not awaited, not tied to any request. Errors are surfaced as events by runAgent.
  void (async () => {
    try {
      for await (const event of run(params.messages, params.userInput, params.workspaceDir, params.workspaceId, runOptions)) {
        session.buffer.push(event);
        for (const sub of session.subscribers) {
          try { sub(event); } catch (err) { log.warn({ err }, "subscriber threw"); }
        }
        if (event.type === "turn_usage") recordUsage(sessionId, event);
        if (event.type === "done") break;
      }
    } catch (err) {
      log.error({ err, workspaceId: params.workspaceId, conversationId: params.conversationId }, "detached run failed");
    } finally {
      session.status = "done";
      try { persist(); } catch (err) { log.error({ err }, "persist on run end failed"); }
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
   *  client reconnecting at the end replays from a consistent on-disk history. */
  finish: () => void;
}

/**
 * Register a producer-driven run for a conversation. Returns null if a run is already live for it
 * (mirrors startRun's one-run-per-conversation rule). The caller publishes each event and calls
 * finish() when the whole call — including any correction retries — has completed.
 */
export function startExternalRun(workspaceId: string, conversationId: string, userInput: string): ExternalRun | null {
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
  sessions.set(k, session);

  return {
    publish: (event) => {
      session.buffer.push(event);
      for (const sub of session.subscribers) {
        try { sub(event); } catch (err) { log.warn({ err }, "subscriber threw"); }
      }
    },
    finish: () => {
      if (session.status === "done") return;
      session.status = "done";
      setTimeout(() => {
        if (sessions.get(k) === session) sessions.delete(k);
      }, DONE_LINGER_MS);
    },
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
