// The agentic loop: stream a model turn, dispatch its tools, repeat until a turn has no tool calls.
// Set DEBUG=1 for verbose tool call logging.

import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { Logger } from "pino";
import { buildTools, loadAgentConfig } from "./buildTools";
import type { AgentConfig, PostDispatchContext, PostDispatchFn } from "./interfaces";
import { getContainers } from "../infra/services";
import type {
  IAgentWorkspaceVersioning,
  IContainerManager,
  IWorkspaceLookup,
  IWorkspaceSnapshotWriter,
} from "../infra/interfaces";
import { sendToWorkspace } from "../infra/realtime/wsHub";
import { createLogger } from "../infra/logger";
import type { ToolStatus } from "@/lib/usage/types";
import type { CallAgentMeta } from "./tools/agentCall";
import { streamModelTurn, synthesizeLimit, type ResolvedToolCall } from "./modelTurn";
import { NO_USAGE, type ModelCallObserver, type ModelCallRecord, type ModelUsage } from "./modelGateway";
import { type MistralReplayContent, withMistralReplayMetadata } from "./mistralProtocol";
import { providerConcurrency } from "./providerConcurrency";
import { dispatchTools, type RunnerTool } from "./toolDispatch";
import {
  preflightProviderFailure,
  providerFailureMessage,
  reportProviderFailure,
  type ProviderFailureCode,
} from "./providerFailure";
import { availableProviders } from "./buildModel";

const log = createLogger("agent");

/**
 * Why a run ended without an answer. Every code names a cause the model cannot work around, so
 * consumers (chat, API stream, skill callers, the usage dashboard) can explain the stop instead of
 * showing a raw provider string — or, worse, an empty conversation.
 */
export type AgentErrorCode =
  | "TIMEOUT"
  | "CANCELLED"
  | "INFRASTRUCTURE_UNAVAILABLE"
  // The shared list, so a code added to providerFailure.ts cannot be one this union rejects. All of
  // them, not only the terminal ones: a survivable cause still has to explain why THIS run stopped.
  | ProviderFailureCode;

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  // The provider's tool_call id, pairing tool_link/tool_result with the bubble tool_start opened —
  // which `name` cannot do for parallel calls to one tool. Consumers fall back to `name` without it.
  | { type: "tool_start"; name: string; id?: string; args: Record<string, unknown> }
  // call_agent only: emitted mid-run, the moment the callee's conversation is created, so the
  // caller shows the "View session" deep-link while the callee is still working (not just at end).
  | { type: "tool_link"; name: string; id?: string; meta: CallAgentMeta }
  // `meta` is set only for call_agent: a deep-link to the callee's persisted session.
  | { type: "tool_result"; name: string; id?: string; result: string; meta?: CallAgentMeta }
  | { type: "error"; message: string; code?: AgentErrorCode }
  // The run is alive but waiting on a provider's rate limit. Transient: it exists so a paced run
  // reads as slow rather than frozen, and it is replaced by the next real event, never kept.
  | { type: "paced"; provider: string; model: string; waitMs: number; queueDepth: number }
  | { type: "limit_reached" }
  | { type: "done" }
  | {
      type: "turn_usage";
      /** Stable id shared by the persisted AIMessage and its execution record. */
      turnId: string;
      model?: string;
      inputTokensTotal: number;
      inputTokensCacheRead: number;
      inputTokensCacheWrite: number;
      outputTokensTotal: number;
      outputTokensReasoning: number;
      userInput?: string;
      reasoningText?: string;
      outputText?: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown>; output: string; status: ToolStatus }>;
    };

export type RunAgentOptions = {
  signal?: AbortSignal;
  maxIterations?: number;
  /** Override WebSocket notification sender — defaults to sendToWorkspace. Inject for testing. */
  notify?: (msg: object) => void;
  /** Override container warm-up — defaults to ensureContainer. Inject for testing. */
  warmContainer?: () => void;
  /** Override config loading — defaults to loadAgentConfig. Inject for testing. */
  loadConfig?: (workspaceId?: string) => AgentConfig;
  /** Override tool/model construction — defaults to buildTools. Inject for testing. */
  buildAgentTools?: typeof buildTools;
  /** Container lifecycle manager — defaults to the production singleton. Inject for testing. */
  containers?: IContainerManager;
  /** Workspace store — defaults to the production singleton. Inject for testing. */
  store?: IWorkspaceLookup;
  /**
   * Workspace git versioning. When provided, the run is bracketed by a baseline snapshot (start)
   * and a single result commit (end). Omitted in tests that don't care about versioning — every
   * git call is guarded, so an absent service simply skips all snapshotting.
   */
  versioning?: IAgentWorkspaceVersioning;
  /**
   * Post-dispatch signal handlers — one per signal-tool name. Defaults to the map returned by
   * buildAgentTools. Inject for testing to exercise runner dispatch without a full buildTools call.
   */
  signalHandlers?: Record<string, PostDispatchFn>;
};

// Threaded from the route layer down through the broker and nested agent calls, so one setServices()
// swap flows end-to-end. Separate from RunAgentOptions, which also holds test-only seams.
export type AgentRuntimeDeps = Pick<RunAgentOptions, "store" | "containers" | "versioning">;

export { classifyToolStatus } from "./toolUtils";

async function tryCommitBaseline(
  versioning: IWorkspaceSnapshotWriter | undefined,
  workspaceId: string,
  workspaceDir: string,
  prompt: string,
  wlog: Logger,
): Promise<void> {
  if (!versioning) return;
  try {
    await versioning.commitBaseline(workspaceId, workspaceDir, prompt);
  } catch (err) {
    wlog.warn({ err }, "versioning baseline commit failed");
  }
}

async function tryCommitResult(
  versioning: IWorkspaceSnapshotWriter | undefined,
  workspaceId: string,
  workspaceDir: string,
  prompt: string,
  wlog: Logger,
): Promise<void> {
  if (!versioning) return;
  try {
    await versioning.commitResult(workspaceId, workspaceDir, prompt);
  } catch (err) {
    wlog.warn({ err }, "versioning result commit failed");
  }
}

export async function* runAgent(
  messages: BaseMessage[],
  userInput: string,
  workspaceDir: string,
  workspaceId: string,
  {
    signal,
    maxIterations = 30,
    notify,
    warmContainer,
    loadConfig,
    buildAgentTools,
    containers,
    store,
    versioning,
    signalHandlers: injectedHandlers,
  }: RunAgentOptions = {},
): AsyncGenerator<AgentEvent> {
  const wlog = log.child({ workspaceId });
  const config = (loadConfig ?? loadAgentConfig)(workspaceId);
  const modelId = config.model;

  // Both facts are known before a container is warmed or a byte leaves the process, and the message
  // names the fix — where an SDK credential error in a transcript would not.
  const blocked = preflightProviderFailure(config, availableProviders());
  if (blocked) {
    wlog.warn(
      {
        event: "run_blocked_unusable_model_selection",
        outcome: "run_stopped_before_first_call",
        code: blocked.code,
        provider: config.provider,
        model: config.model,
      },
      "run stopped before its first model call — unusable model selection",
    );
    yield { type: "error", code: blocked.code, message: blocked.message };
    yield { type: "done" };
    return;
  }

  const resolvedContainers = containers ?? getContainers();

  // Compaction runs inside a signal handler, which cannot yield. Its cost is parked here and drained
  // into turn_usage below, so the summary request lands in the same ledger as every other call.
  const pendingCompaction: ModelCallRecord[] = [];
  const observeModelCall: ModelCallObserver = (record) => {
    wlog.debug({ event: "model_call", ...record, ...record.usage }, "model call complete");
    if (record.stage === "compaction") pendingCompaction.push(record);
  };

  const {
    modelWithTools,
    model,
    toolMap,
    signalHandlers: builtHandlers,
  } = (buildAgentTools ?? buildTools)(workspaceId, workspaceDir, config, {
    containers: resolvedContainers,
    store,
    observe: observeModelCall,
  });
  const signalHandlers: Record<string, PostDispatchFn> = injectedHandlers ?? builtHandlers ?? {};
  const typedToolMap = toolMap as Record<string, RunnerTool>;

  // Through the hub rather than straight at the socket: notify carries every tool_call and
  // tool_result_log of a run, so it needs the same backpressure bound as the console stream.
  const resolvedNotify = notify ?? ((msg: object) => void sendToWorkspace(workspaceId, JSON.stringify(msg)));
  const resolvedWarmContainer =
    warmContainer ??
    (() =>
      resolvedContainers.ensure(workspaceId, workspaceDir).catch((err: unknown) => {
        wlog.warn({ err }, "container pre-warm failed");
      }));
  // Warm the container while the first LLM call is in flight. ensureContainer is idempotent and
  // coalesces, so a later execCommand call is a no-op if it is already running.
  resolvedWarmContainer();

  // Built once per run; passed to each PostDispatchFn after every tool turn settles.
  const postDispatchCtx: PostDispatchContext = {
    messages,
    versioning,
    workspaceId,
    workspaceDir,
    model,
    notify: resolvedNotify,
    log: wlog,
  };

  messages.push(new HumanMessage(userInput));
  // The broker/stream owner emits the correlated info-level run lifecycle with session and
  // conversation ids. Keep this inner loop boundary at debug to avoid duplicate production lines.
  wlog.debug({ maxIterations }, "agent loop started");

  await tryCommitBaseline(versioning, workspaceId, workspaceDir, userInput, wlog);

  let iterations = 0;
  try {
    while (true) {
      if (iterations >= maxIterations) {
        wlog.warn({ iterations }, "agent loop limit reached");
        yield { type: "limit_reached" };
        yield* synthesizeLimit(model, messages, signal, wlog, modelId);
        yield { type: "done" };
        break;
      }
      iterations++;
      const turnId = crypto.randomUUID();

      let fullText = "";
      let reasoningText = "";
      let toolCalls: ResolvedToolCall[] = [];
      let usage: ModelUsage = NO_USAGE;
      let mistralContent: MistralReplayContent | undefined;

      for await (const event of streamModelTurn(modelWithTools, messages, iterations, signal, wlog)) {
        if (event.type === "turn_complete") {
          fullText = event.fullText;
          toolCalls = event.toolCalls;
          usage = event.usage;
          mistralContent = event.mistralReplayContent;
        } else {
          if (event.type === "reasoning") reasoningText += event.content;
          yield event;
        }
      }

      // Shared by both exit paths. userInput rides only the first turn; outputText is the model's
      // prose — preamble on tool turns, the answer on the last. Emitted after tools settle, below.
      const usageBase = {
        turnId,
        ...usage,
        ...(modelId ? { model: modelId } : {}),
        ...(iterations === 1 ? { userInput } : {}),
        ...(reasoningText ? { reasoningText } : {}),
        ...(fullText ? { outputText: fullText } : {}),
      };

      if (!toolCalls.length) {
        // Final text response — tokens already streamed as they arrived; just persist and exit.
        yield { type: "turn_usage", ...usageBase, toolCalls: [] };
        messages.push(
          new AIMessage({
            content: fullText,
            // The execution ledger owns token measurements. Replay state keeps only the stable
            // reference used to join those measurements when a conversation is reopened.
            response_metadata: withMistralReplayMetadata({ executionTurnId: turnId }, mistralContent),
          }),
        );
        wlog.debug("agent loop done");
        yield { type: "done" };
        break;
      }

      // Deduplicate: keep only the last of any calls with identical name+args, so every
      // tool_call on the assistant message gets exactly one matching ToolMessage.
      const seen = new Map<string, number>();
      toolCalls.forEach((tc, i) => seen.set(`${tc.name}:${JSON.stringify(tc.args)}`, i));
      const activeCalls = toolCalls.filter((tc, i) => seen.get(`${tc.name}:${JSON.stringify(tc.args)}`) === i);

      // Canonical history remains plain text for every provider. Mistral's sanitized ThinkChunk is
      // private response metadata; its gateway adapter alone restores it on an outbound clone.
      const assistantTurn = new AIMessage({
        content: fullText,
        tool_calls: activeCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
        response_metadata: withMistralReplayMetadata({ executionTurnId: turnId }, mistralContent),
      });

      for (const tc of activeCalls) {
        yield { type: "tool_start", name: tc.name, id: tc.id, args: tc.args };
        resolvedNotify({ type: "tool_call", name: tc.name, args: tc.args });
        wlog.debug({ name: tc.name, argumentKeys: Object.keys(tc.args) }, "tool call");
      }

      // Tool execution is delegated, while this loop keeps ownership of event ordering and the
      // atomic history commit below.
      const dispatch = dispatchTools(activeCalls, typedToolMap, signal, wlog);

      // Drain link events as they arrive, exiting once all tools settle. Suspends only before the
      // atomic commit below, so an abort during the wait cannot leave a half-written turn.
      for await (const link of dispatch.links) {
        yield { type: "tool_link", name: link.name, id: link.id, meta: link.meta };
      }
      const settled = await dispatch.settled;

      // One synchronous block, no yield or await between: an abort abandons the generator at a
      // yield, so history holds all of this turn or none — never tool_calls without ToolMessages.
      messages.push(assistantTurn);
      for (const { tc, resultStr, meta } of settled) {
        // Persist the callee deep-link on the ToolMessage so a reloaded caller conversation can
        // rebuild the link (the live `meta` event is gone by then). See messagesToTranscript.
        messages.push(
          new ToolMessage({
            tool_call_id: tc.id,
            content: resultStr,
            ...(meta
              ? {
                  additional_kwargs: {
                    calleeConversationId: meta.conversationId,
                    calleeWorkspaceId: meta.workspaceId,
                    calleeWorkspaceName: meta.workspaceName,
                  },
                }
              : {}),
          }),
        );
      }

      for (const { tc, resultStr, meta } of settled) {
        yield { type: "tool_result", name: tc.name, id: tc.id, result: resultStr, ...(meta ? { meta } : {}) };
        if (!typedToolMap[tc.name]?.suppressResultNotify) {
          resolvedNotify({ type: "tool_result_log", name: tc.name, result: resultStr });
        }
        wlog.debug({ name: tc.name, resultChars: resultStr.length }, "tool result");
      }

      // Emit usage now that outputs are known, attaching each tool call's result.
      yield {
        type: "turn_usage",
        ...usageBase,
        toolCalls: settled.map(({ tc, resultStr, status }) => ({
          name: tc.name,
          args: tc.args,
          output: resultStr,
          status,
        })),
      };

      // A host-wide non-retryable failure survives another model turn. End after persisting the
      // tool turn, so every consumer gets one terminal error instead of a run of doomed tools.
      const terminalFailure = settled.find(({ terminalFailure }) => terminalFailure)?.terminalFailure;
      if (terminalFailure) {
        yield { type: "error", ...terminalFailure };
        yield { type: "done" };
        break;
      }

      // Escape: the tools above are already killed and committed, so history stays resumable. Stop
      // rather than looping into another immediately-aborted stream. Skips compaction.
      if (signal?.aborted) {
        wlog.debug("agent loop aborted");
        yield { type: "done" };
        break;
      }

      // Signal-tool side-effects (restore, compact…), after the atomic commit. A new signal tool
      // only needs an entry in buildTools.signalHandlers; this loop never changes.
      for (const { tc, resultStr } of settled) {
        const handler = signalHandlers[tc.name];
        if (handler) await handler(tc.args, resultStr, postDispatchCtx);
      }

      // Whatever compaction just spent. A fresh turnId each: these are their own rows, not an
      // amendment to the turn whose tool call triggered them.
      for (const record of pendingCompaction.splice(0)) {
        yield {
          type: "turn_usage",
          turnId: crypto.randomUUID(),
          model: record.model,
          ...record.usage,
          toolCalls: [],
        };
      }
    }
  } catch (err) {
    // A throw lands here before any tool-call turn is committed, so history stays consistent. The
    // classification names the cause, which `String(err)` cannot; its precedence lives in the rules.
    const failureContext = { workspaceId, provider: config.provider, model: modelId, stage: "model_turn" };
    const failure = reportProviderFailure(wlog, err, failureContext);
    // One line per failed run, whatever the cause. The report above is throttled per provider;
    // routing this through it would silence the per-run record during the outage it exists to catch.
    wlog.error({ event: "agent_run_failed", outcome: "error_event_emitted", err, ...failure }, "agent run failed");
    if (failure) {
      yield {
        type: "error",
        code: failure.failureCode,
        message: providerFailureMessage(failure, { provider: config.provider, model: modelId }),
      };
    } else {
      yield { type: "error", message: String(err) };
    }
    yield { type: "done" };
  } finally {
    // Process-wide, not this run's: the provider's quota is shared, so the peak worth tuning against
    // is how many calls it was carrying overall. Measurement only — nothing throttles on it yet.
    wlog.info(
      { event: "provider_concurrency", ...providerConcurrency.snapshot(config.provider) },
      "provider concurrency at run end",
    );
    // One result commit on EVERY exit path, abort included (`.return()` still runs `finally`).
    // commitResult skips a run that changed nothing, and is try/caught so versioning cannot break it.
    await tryCommitResult(versioning, workspaceId, workspaceDir, userInput, wlog);
  }
}
