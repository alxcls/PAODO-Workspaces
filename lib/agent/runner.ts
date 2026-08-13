// Drives the agent's agentic loop: streams every model turn, collecting text tokens
// and tool-call chunks simultaneously, then dispatches tools and loops until a turn
// arrives with neither native nor inline tool calls.
// Set DEBUG=1 in the environment to enable verbose tool call logging.

import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
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
import { streamModelTurn, synthesizeLimit, usageTokens, type ResolvedToolCall } from "./modelTurn";
import { dispatchTools, type RunnerTool } from "./toolDispatch";

const log = createLogger("agent");

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  // `id` is the provider's tool_call id: it pairs tool_link/tool_result with the exact bubble
  // tool_start opened, which `name` cannot do when a turn runs several calls to the same tool
  // in parallel. Optional — not every provider supplies one; consumers fall back to `name`.
  | { type: "tool_start"; name: string; id?: string; args: Record<string, unknown> }
  // call_agent only: emitted mid-run, the moment the callee's conversation is created, so the
  // caller shows the "View session" deep-link while the callee is still working (not just at end).
  | { type: "tool_link"; name: string; id?: string; meta: CallAgentMeta }
  // `meta` is set only for call_agent: a deep-link to the callee's persisted session.
  | { type: "tool_result"; name: string; id?: string; result: string; meta?: CallAgentMeta }
  | { type: "error"; message: string; code?: "TIMEOUT" | "CANCELLED" }
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

// The injectable infra pair, threaded from the route layer (via getStore()/getContainers())
// down through the run broker and nested agent-to-agent calls so a single setServices() swap
// flows end-to-end. Kept separate from RunAgentOptions so callers that only forward infra
// don't have to know about the test-only override seams.
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
  const resolvedContainers = containers ?? getContainers();
  const {
    modelWithTools,
    model,
    toolMap,
    signalHandlers: builtHandlers,
  } = (buildAgentTools ?? buildTools)(workspaceId, workspaceDir, config, { containers: resolvedContainers, store });
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
  // Start spinning up the workspace container while the first LLM call is in flight.
  // ensureContainer is idempotent and coalesces concurrent calls, so execCommand calling
  // it again later is a no-op if the container is already running.
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
      let accumulatedChunk: AIMessageChunk | null = null;

      for await (const event of streamModelTurn(modelWithTools, messages, iterations, signal, wlog)) {
        if (event.type === "turn_complete") {
          fullText = event.fullText;
          toolCalls = event.toolCalls;
          accumulatedChunk = event.accumulatedChunk;
        } else {
          if (event.type === "reasoning") reasoningText += event.content;
          yield event;
        }
      }

      // Per-turn usage shared by both exit paths. userInput is attached only on the first turn
      // (it's the message that started the session); reasoningText/outputText/tool outputs make
      // the turn observable in the usage dashboard. outputText is the model's prose for this turn
      // — preamble alongside tool calls on intermediate turns, and the final answer on the
      // terminal (no-tool) turn. Emitted AFTER tools settle (below) so tool outputs are included;
      // the no-tool final turn emits it here with no tool calls.
      const usageBase = {
        turnId,
        ...usageTokens(accumulatedChunk),
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
            response_metadata: { executionTurnId: turnId },
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

      // Persist the coalesced text, NOT accumulatedChunk.content. The raw streamed content array
      // carries provider-specific, streaming-only blocks — extended-thinking `thinking` blocks
      // (with signatures) and partial `input_json_delta` tool-input deltas — that are not valid
      // *input* content. Replaying them breaks the next request (a text-only provider rejects them
      // with `unknown variant 'thinking', expected 'text'`) and they don't survive a per-workspace
      // model switch. The tool calls are carried separately via tool_calls (re-encoded per provider
      // on send); reasoning is intentionally omitted from replay (see messageSerialization.ts).
      // This mirrors the terminal-turn push above, which already persists fullText.
      const assistantTurn = new AIMessage({
        content: fullText,
        tool_calls: activeCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
        response_metadata: { executionTurnId: turnId },
      });

      for (const tc of activeCalls) {
        yield { type: "tool_start", name: tc.name, id: tc.id, args: tc.args };
        resolvedNotify({ type: "tool_call", name: tc.name, args: tc.args });
        wlog.debug({ name: tc.name, argumentKeys: Object.keys(tc.args) }, "tool call");
      }

      // Tool execution is delegated, while this loop keeps ownership of event ordering and the
      // atomic history commit below.
      const dispatch = dispatchTools(activeCalls, typedToolMap, signal, wlog);

      // Drain link events as they arrive; exits once all tools settled and queue is empty.
      // Suspends only before the atomic history-commit below — an abort during the wait can
      // never leave a half-written turn.
      for await (const link of dispatch.links) {
        yield { type: "tool_link", name: link.name, id: link.id, meta: link.meta };
      }
      const settled = await dispatch.settled;

      // Commit the assistant turn and all its tool results in one synchronous block, with no
      // yield or await in between. If the request is aborted (the user hits escape) the runner
      // generator is abandoned at a yield — so it can only ever observe history with either
      // none of this turn or all of it, never an AIMessage whose tool_calls lack their
      // ToolMessages (which OpenAI rejects on the next request).
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

      // User pressed escape: the tools above have already been killed and their results committed
      // (atomic block, so history stays valid for a later resume). Stop here instead of looping
      // back into another — immediately aborted — model stream. Skip compaction on the way out.
      if (signal?.aborted) {
        wlog.debug("agent loop aborted");
        yield { type: "done" };
        break;
      }

      // Signal-tool post-dispatch: runs AFTER the atomic turn commit above. Each handler in
      // signalHandlers receives args + resultStr and performs its side-effect (restore, compact…).
      // Adding a new signal tool only requires a new entry in buildTools.signalHandlers — this
      // loop never changes. Best-effort: errors are caught inside each handler.
      for (const { tc, resultStr } of settled) {
        const handler = signalHandlers[tc.name];
        if (handler) await handler(tc.args, resultStr, postDispatchCtx);
      }
    }
  } catch (err) {
    // A thrown error (e.g. the model stream aborting mid-turn) lands here before any
    // assistant tool-call turn is committed, so history is left consistent — see the
    // atomic commit above. Just surface the error and close the stream.
    wlog.error({ event: "agent_run_failed", outcome: "error_event_emitted", err }, "agent run failed");
    yield { type: "error", message: String(err) };
    yield { type: "done" };
  } finally {
    // Single result commit for the run, on EVERY exit path — normal completion, iteration limit,
    // user abort (the SSE consumer abandons this generator via `.return()`, which still runs
    // `finally`), and thrown errors. commitResult skips itself if the run changed nothing, so a
    // no-op run leaves no commit. Guarded + try/caught so versioning never breaks the run.
    await tryCommitResult(versioning, workspaceId, workspaceDir, userInput, wlog);
  }
}
