// Drives the agent's agentic loop: streams every model turn, collecting text tokens
// and tool-call chunks simultaneously, then dispatches tools and loops until a turn
// arrives with neither native nor inline tool calls.
// Set DEBUG=1 in the environment to enable verbose tool call logging.

import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { Logger } from "pino";
import { buildTools, loadAgentConfig } from "./buildTools";
import { classifyToolStatus } from "./toolUtils";
import type { AgentConfig, PostDispatchContext, PostDispatchFn } from "./interfaces";
import { getContainers } from "../infra/services";
import type { IContainerManager, IWorkspaceStore, IWorkspaceVersioning } from "../infra/interfaces";
import { getWsForWorkspace } from "../infra/realtime/wsHub";
import { createLogger } from "../infra/logger";
import type { ToolStatus } from "../workspace/usageStore";
import type { CallAgentMeta } from "./tools/agentCall";

const log = createLogger("agent");

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  // call_agent only: emitted mid-run, the moment the callee's conversation is created, so the
  // caller shows the "View session" deep-link while the callee is still working (not just at end).
  | { type: "tool_link"; name: string; meta: CallAgentMeta }
  // `meta` is set only for call_agent: a deep-link to the callee's persisted session.
  | { type: "tool_result"; name: string; result: string; meta?: CallAgentMeta }
  | { type: "error"; message: string }
  | { type: "limit_reached" }
  | { type: "done" }
  | {
      type: "turn_usage";
      model?: string;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      cachedInputTokens: number;
      cacheCreationTokens: number;
      userInput?: string;
      reasoningText?: string;
      outputText?: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown>; output: string; status: ToolStatus }>;
    };

export type RunAgentOptions = {
  signal?: AbortSignal;
  maxIterations?: number;
  /** Override WebSocket notification sender — defaults to getWsForWorkspace. Inject for testing. */
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
  store?: IWorkspaceStore;
  /**
   * Workspace git versioning. When provided, the run is bracketed by a baseline snapshot (start)
   * and a single result commit (end). Omitted in tests that don't care about versioning — every
   * git call is guarded, so an absent service simply skips all snapshotting.
   */
  versioning?: IWorkspaceVersioning;
  /**
   * Post-dispatch signal handlers — one per signal-tool name. Defaults to the map returned by
   * buildAgentTools. Inject for testing to exercise runner dispatch without a full buildTools call.
   */
  signalHandlers?: Record<string, PostDispatchFn>;
};

// The injectable infra pair, threaded from the route layer (via getStore()/getContainers())
// down through agentStream and nested agent-to-agent calls so a single setServices() swap
// flows end-to-end. Kept separate from RunAgentOptions so callers that only forward infra
// don't have to know about the test-only override seams.
export type AgentRuntimeDeps = Pick<RunAgentOptions, "store" | "containers" | "versioning">;

type AnyTool = {
  name: string;
  invoke: (args: Record<string, unknown>, config?: { signal?: AbortSignal }) => Promise<unknown>;
  /** When true the runner skips the WS tool_result_log broadcast for this tool's result. */
  suppressResultNotify?: boolean;
  /** When true the runner skips the MAX_RESULT_CHARS truncation for this tool's result. */
  skipResultCap?: boolean;
  /** Present on tools that need to return UI metadata alongside the model-facing string. */
  callWithMeta?: AgentCallWithMeta;
};
type ResolvedToolCall = { id: string; name: string; args: Record<string, unknown> };
// Structural type for AgentCallTool.callWithMeta — duck-typed so the runner needn't import the
// concrete tool class (which would deepen the buildTools → agentCall import chain). The optional
// onLink callback fires as soon as the callee's conversation is created (before the call resolves)
// so the runner can surface the deep-link mid-run.
type AgentCallWithMeta = (
  args: Record<string, unknown>,
  onLink?: (meta: CallAgentMeta) => void,
  callerSignal?: AbortSignal,
) => Promise<{ result: string; meta?: CallAgentMeta }>;
type PartialTC = { id: string; name: string; args: string };

type TurnEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "turn_complete"; fullText: string; toolCalls: ResolvedToolCall[]; accumulatedChunk: AIMessageChunk | null };

// Newer models return content as an array of typed blocks instead of a plain string.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) return (block as { text: string }).text;
        return "";
      })
      .join("");
  }
  return "";
}

const MAX_RESULT_CHARS = 50_000;

async function invokeTool(tool: AnyTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  // Thread the abort signal into the tool so a user escape reaches long-running work (e.g.
  // execute_command's in-container process). Tools that ignore the config are unaffected.
  const result = await tool.invoke(args, { signal });
  const str = String(result);
  // Tools with their own paging (e.g. file_read) opt out via skipResultCap. Every other tool
  // (execute_command, web_fetch, glob, …) has no paging and unpredictable output, so the cap
  // stays as a guardrail against one result blowing out the context window.
  if (tool.skipResultCap) return str;
  if (str.length <= MAX_RESULT_CHARS) return str;
  // Cut on a line boundary so the model never sees a half-line (e.g. mid-token in a JSON
  // value). Fall back to a hard slice if the first line alone already exceeds the budget.
  const lastNewline = str.lastIndexOf("\n", MAX_RESULT_CHARS);
  const cut = lastNewline > 0 ? lastNewline : MAX_RESULT_CHARS;
  return str.slice(0, cut) + `\n\n[output truncated — ${str.length} chars total, showing first ${cut}]`;
}

export { classifyToolStatus } from "./toolUtils";

// Splits a stream chunk into text tokens and reasoning/thinking blocks.
// Centralises all provider-specific branch logic (OpenAI reasoning, Anthropic thinking,
// additional_kwargs.reasoning_content) so adding a new provider only touches this function.
type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "reasoning"; reasoning?: string }
  | { type: "thinking"; thinking?: string }
  | { type: string };

function extractContentFromChunk(chunk: AIMessageChunk): { tokens: string[]; reasoning: string[] } {
  const tokens: string[] = [];
  const reasoning: string[] = [];
  const rawContent = chunk.content;
  if (typeof rawContent === "string") {
    if (rawContent) tokens.push(rawContent);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent as (string | ContentBlock)[]) {
      if (typeof block === "string") {
        if (block) tokens.push(block);
        continue;
      }
      switch (block.type) {
        case "text":
          if ("text" in block && block.text) tokens.push(block.text);
          break;
        case "reasoning":
          if ("reasoning" in block && block.reasoning) reasoning.push(block.reasoning);
          break;
        case "thinking":
          if ("thinking" in block && block.thinking) reasoning.push(block.thinking);
          break;
        default:
          // Surface unrecognized block shapes (e.g. from a new provider) instead of
          // dropping them silently. Kept at debug level to avoid noise.
          log.debug({ blockType: block.type }, "unhandled content block type");
      }
    }
  }
  const reasoningContent = (chunk as unknown as { additional_kwargs?: { reasoning_content?: string } })
    .additional_kwargs?.reasoning_content;
  if (reasoningContent) reasoning.push(reasoningContent);
  return { tokens, reasoning };
}

// Extracts the per-turn token counts from the accumulated stream chunk's usage metadata.
function usageTokens(chunk: AIMessageChunk | null) {
  return {
    inputTokens: chunk?.usage_metadata?.input_tokens ?? 0,
    outputTokens: chunk?.usage_metadata?.output_tokens ?? 0,
    reasoningTokens: chunk?.usage_metadata?.output_token_details?.reasoning ?? 0,
    // DeepSeek exposes cache hits in prompt_cache_hit_tokens (top-level usage), not
    // prompt_tokens_details.cached_tokens, so LangChain's OpenAI adapter misses it.
    cachedInputTokens:
      chunk?.usage_metadata?.input_token_details?.cache_read ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chunk?.response_metadata as any)?.usage?.prompt_cache_hit_tokens ??
      0,
    cacheCreationTokens: chunk?.usage_metadata?.input_token_details?.cache_creation ?? 0,
  };
}

function assembleToolCalls(partials: PartialTC[]): ResolvedToolCall[] {
  return partials
    .filter((p) => p.name)
    .map((p, i) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(p.args || "{}");
      } catch {
        /* leave empty */
      }
      return { id: p.id || `tc_${i}_${Date.now()}`, name: p.name, args };
    });
}

// Streams one model turn, yielding tokens and reasoning as they arrive, then a
// turn_complete event with the assembled tool calls and accumulated chunk.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function* streamModelTurn(
  modelWithTools: any,
  messages: BaseMessage[],
  iteration: number,
  signal: AbortSignal | undefined,
  wlog: Logger,
): AsyncGenerator<TurnEvent> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const partials: PartialTC[] = [];
  let fullText = "";
  let accumulatedChunk: AIMessageChunk | null = null;

  const t0 = Date.now();
  const stream = await modelWithTools.stream(messages, { signal });
  let ttftMs: number | null = null;

  for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
    if (ttftMs === null) ttftMs = Date.now() - t0;
    accumulatedChunk = accumulatedChunk ? accumulatedChunk.concat(chunk) : chunk;

    const { tokens, reasoning } = extractContentFromChunk(chunk);
    for (const text of tokens) {
      fullText += text;
      yield { type: "token", content: text };
    }
    for (const r of reasoning) {
      yield { type: "reasoning", content: r };
    }

    for (const tcc of chunk.tool_call_chunks ?? []) {
      const idx = tcc.index ?? 0;
      if (!partials[idx]) partials[idx] = { id: "", name: "", args: "" };
      if (tcc.id) partials[idx].id = tcc.id;
      if (tcc.name) partials[idx].name += tcc.name;
      if (tcc.args) partials[idx].args += tcc.args;
    }
  }

  wlog.debug({ iteration, ttftMs, streamMs: Date.now() - t0 }, "model stream timing");
  yield { type: "turn_complete", fullText, toolCalls: assembleToolCalls(partials), accumulatedChunk };
}

// Streams a summary turn after the iteration limit is reached.
// Mutates messages to append the summary so subsequent history is coherent.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function* synthesizeLimit(
  model: any,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
  wlog: Logger,
): AsyncGenerator<AgentEvent> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  wlog.info("limit synthesis started");
  try {
    const synthMessages = [
      ...messages,
      new HumanMessage(
        "You have reached the maximum number of steps. Briefly summarize what you accomplished and what still needs to be done. Do not attempt any tool calls.",
      ),
    ];
    const synthStream = await model.stream(synthMessages, { signal });
    let synthText = "";
    for await (const chunk of synthStream as AsyncIterable<AIMessageChunk>) {
      const text = contentToText(chunk.content);
      if (text) {
        synthText += text;
        yield { type: "token", content: text };
      }
    }
    if (synthText) messages.push(new AIMessage(synthText));
    wlog.info({ chars: synthText.length }, "limit synthesis done");
  } catch (err) {
    wlog.error({ err }, "limit synthesis failed");
  }
}

async function tryCommitBaseline(
  versioning: IWorkspaceVersioning | undefined,
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
  versioning: IWorkspaceVersioning | undefined,
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

function createLinkQueue() {
  const queue: Array<{ name: string; meta: CallAgentMeta }> = [];
  let wakeUp: (() => void) | null = null;
  let done = false;

  return {
    emitLink(name: string, meta: CallAgentMeta) {
      queue.push({ name, meta });
      wakeUp?.();
      wakeUp = null;
    },
    notifySettled() {
      done = true;
      wakeUp?.();
      wakeUp = null;
    },
    async *drainUntilSettled(): AsyncGenerator<{ name: string; meta: CallAgentMeta }> {
      while (!done || queue.length) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((res) => {
          wakeUp = res;
        });
      }
    },
  };
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
  const typedToolMap = toolMap as Record<string, AnyTool>;

  const resolvedNotify = notify ?? ((msg: object) => getWsForWorkspace(workspaceId)?.send(JSON.stringify(msg)));
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
  wlog.info({ maxIterations }, "agent run started");

  await tryCommitBaseline(versioning, workspaceId, workspaceDir, userInput, wlog);

  let iterations = 0;
  // Run-cumulative token totals, summed across every turn. Mirrors the client's per-run usage
  // line (agentTranscript.insertUsage): attached to the terminal assistant message below so a
  // reloaded conversation shows the same single usage line the live stream did.
  let runInputTokens = 0;
  let runOutputTokens = 0;
  try {
    while (true) {
      if (iterations >= maxIterations) {
        wlog.warn({ iterations }, "agent loop limit reached");
        yield { type: "limit_reached" };
        yield* synthesizeLimit(model, messages, signal, wlog);
        yield { type: "done" };
        break;
      }
      iterations++;

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
        ...usageTokens(accumulatedChunk),
        ...(modelId ? { model: modelId } : {}),
        ...(iterations === 1 ? { userInput } : {}),
        ...(reasoningText ? { reasoningText } : {}),
        ...(fullText ? { outputText: fullText } : {}),
      };
      runInputTokens += usageBase.inputTokens;
      runOutputTokens += usageBase.outputTokens;

      if (!toolCalls.length) {
        // Final text response — tokens already streamed as they arrived; just persist and exit.
        yield { type: "turn_usage", ...usageBase, toolCalls: [] };
        // Stash the run-cumulative usage on the persisted message so messagesToTranscript can
        // replay the usage line on reload (response_metadata survives serialization).
        messages.push(
          new AIMessage({
            content: fullText,
            response_metadata: { runUsage: { inputTokens: runInputTokens, outputTokens: runOutputTokens } },
          }),
        );
        wlog.info("agent run done");
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
      });

      for (const tc of activeCalls) {
        yield { type: "tool_start", name: tc.name, args: tc.args };
        resolvedNotify({ type: "tool_call", name: tc.name, args: tc.args });
        wlog.debug({ name: tc.name, args: tc.args }, "tool call");
      }

      // call_agent surfaces its callee-session deep-link the moment the callee conversation is
      // created (via the onLink callback below), not when the whole call finishes — so the caller
      // sees "View session" while the callee is still working. Links are drained as they arrive;
      // all tools settle before the atomic history-commit block below.
      const lq = createLinkQueue();
      const settledPromise = Promise.all(
        activeCalls.map(async (tc) => {
          const tool = typedToolMap[tc.name];
          const toolStart = Date.now();
          let resultStr: string;
          let meta: CallAgentMeta | undefined;
          // Tools that return UI metadata alongside the model-facing string expose callWithMeta
          // (a bound arrow property, so it can be called free-standing without a thisArg).
          const withMeta = tool?.callWithMeta;
          if (withMeta) {
            const r = await withMeta(tc.args, (m) => lq.emitLink(tc.name, m), signal).catch((err) => ({
              result: `Error: ${String(err)}`,
              meta: undefined,
            }));
            resultStr = r.result;
            meta = r.meta;
          } else {
            resultStr = tool
              ? await invokeTool(tool, tc.args, signal).catch((err) => `Error: ${String(err)}`)
              : `Error: unknown tool "${tc.name}"`;
          }
          wlog.debug({ name: tc.name, toolMs: Date.now() - toolStart }, "tool timing");
          return { tc, resultStr, meta };
        }),
      ).then((s) => {
        lq.notifySettled();
        return s;
      });

      // Drain link events as they arrive; exits once all tools settled and queue is empty.
      // Suspends only before the atomic history-commit below — an abort during the wait can
      // never leave a half-written turn.
      for await (const link of lq.drainUntilSettled()) {
        yield { type: "tool_link", name: link.name, meta: link.meta };
      }
      const settled = await settledPromise;

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
        yield { type: "tool_result", name: tc.name, result: resultStr, ...(meta ? { meta } : {}) };
        if (!typedToolMap[tc.name]?.suppressResultNotify) {
          resolvedNotify({ type: "tool_result_log", name: tc.name, result: resultStr });
        }
        wlog.debug({ name: tc.name, result: resultStr.slice(0, 200) }, "tool result");
      }

      // Emit usage now that outputs are known, attaching each tool call's result.
      yield {
        type: "turn_usage",
        ...usageBase,
        toolCalls: settled.map(({ tc, resultStr }) => ({
          name: tc.name,
          args: tc.args,
          output: resultStr,
          status: classifyToolStatus(resultStr),
        })),
      };

      // User pressed escape: the tools above have already been killed and their results committed
      // (atomic block, so history stays valid for a later resume). Stop here instead of looping
      // back into another — immediately aborted — model stream. Skip compaction on the way out.
      if (signal?.aborted) {
        wlog.info("agent run aborted by user");
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
    wlog.error({ err }, "agent run failed");
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
