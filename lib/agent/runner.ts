// Drives the agent's agentic loop: streams every model turn, collecting text tokens
// and tool-call chunks simultaneously, then dispatches tools and loops until a turn
// arrives with neither native nor inline tool calls.
// Set DEBUG=1 in the environment to enable verbose tool call logging.

import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { Logger } from "pino";
import { buildTools, loadAgentConfig } from "./buildTools";
import { applyCompaction, type CompactLevel } from "./compact";
import type { AgentConfig } from "./interfaces";
import { defaultContainerManager } from "../infra/docker/containerManager";
import type { IContainerManager, IWorkspaceStore, IWorkspaceVersioning } from "../infra/interfaces";
import { getWsForWorkspace } from "../infra/realtime/wsHub";
import { createLogger } from "../infra/logger";
import type { ToolStatus } from "../workspace/usageStore";

const log = createLogger("agent");

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "error"; message: string }
  | { type: "limit_reached" }
  | { type: "done" }
  | { type: "turn_usage"; inputTokens: number; outputTokens: number; reasoningTokens: number; cachedInputTokens: number; cacheCreationTokens: number; userInput?: string; reasoningText?: string; outputText?: string; toolCalls: Array<{ name: string; args: Record<string, unknown>; output: string; status: ToolStatus }> };

export type RunAgentOptions = {
  signal?: AbortSignal;
  maxIterations?: number;
  /** Override WebSocket notification sender — defaults to getWsForWorkspace. Inject for testing. */
  notify?: (msg: object) => void;
  /** Override container warm-up — defaults to ensureContainer. Inject for testing. */
  warmContainer?: () => void;
  /** Override config loading — defaults to loadAgentConfig. Inject for testing. */
  loadConfig?: () => AgentConfig;
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
};

// The injectable infra pair, threaded from the route layer (via getStore()/getContainers())
// down through agentStream and nested agent-to-agent calls so a single setServices() swap
// flows end-to-end. Kept separate from RunAgentOptions so callers that only forward infra
// don't have to know about the test-only override seams.
export type AgentRuntimeDeps = Pick<RunAgentOptions, "store" | "containers" | "versioning">;

type AnyTool = { invoke: (args: Record<string, unknown>, config?: { signal?: AbortSignal }) => Promise<unknown> };
type ResolvedToolCall = { id: string; name: string; args: Record<string, unknown> };
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

const MAX_RESULT_CHARS = 10_000;

async function invokeTool(tool: AnyTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  // Thread the abort signal into the tool so a user escape reaches long-running work (e.g.
  // execute_command's in-container process). Tools that ignore the config are unaffected.
  const result = await tool.invoke(args, { signal });
  const str = String(result);
  return str.length > MAX_RESULT_CHARS
    ? str.slice(0, MAX_RESULT_CHARS) + `\n\n[output truncated — ${str.length} chars total, showing first ${MAX_RESULT_CHARS}]`
    : str;
}

// Classifies a tool's final result string into a structured outcome. Thrown errors and
// unknown tools are already turned into "Error: …" strings at the call site, so reading the
// final string covers every case uniformly. Every tool honors the "Error:"/"Permission
// denied:" failure convention (execute_command surfaces its exit code as such); the A2A
// non-terminal retry state is tagged "Needs input:". See usageStore.ToolStatus.
export function classifyToolStatus(resultStr: string): ToolStatus {
  if (/^Needs input:/.test(resultStr)) return "needs_input";
  if (/^(Error\b|Error \(|Permission denied)/.test(resultStr)) return "error";
  return "ok";
}

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
      try { args = JSON.parse(p.args || "{}"); } catch { /* leave empty */ }
      return { id: p.id || `tc_${i}_${Date.now()}`, name: p.name, args };
    });
}

// Streams one model turn, yielding tokens and reasoning as they arrive, then a
// turn_complete event with the assembled tool calls and accumulated chunk.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* streamModelTurn(modelWithTools: any, messages: BaseMessage[], iteration: number, signal: AbortSignal | undefined, wlog: Logger): AsyncGenerator<TurnEvent> {
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
    for (const text of tokens) { fullText += text; yield { type: "token", content: text }; }
    for (const r of reasoning) { yield { type: "reasoning", content: r }; }

    for (const tcc of chunk.tool_call_chunks ?? []) {
      const idx = tcc.index ?? 0;
      if (!partials[idx]) partials[idx] = { id: "", name: "", args: "" };
      if (tcc.id)   partials[idx].id    = tcc.id;
      if (tcc.name) partials[idx].name += tcc.name;
      if (tcc.args) partials[idx].args += tcc.args;
    }
  }

  wlog.debug({ iteration, ttftMs, streamMs: Date.now() - t0 }, "model stream timing");
  yield { type: "turn_complete", fullText, toolCalls: assembleToolCalls(partials), accumulatedChunk };
}

// Streams a summary turn after the iteration limit is reached.
// Mutates messages to append the summary so subsequent history is coherent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* synthesizeLimit(model: any, messages: BaseMessage[], signal: AbortSignal | undefined, wlog: Logger): AsyncGenerator<AgentEvent> {
  wlog.info("limit synthesis started");
  try {
    const synthMessages = [
      ...messages,
      new HumanMessage(
        "You have reached the maximum number of steps. Briefly summarize what you accomplished and what still needs to be done. Do not attempt any tool calls."
      ),
    ];
    const synthStream = await model.stream(synthMessages, { signal });
    let synthText = "";
    for await (const chunk of synthStream as AsyncIterable<AIMessageChunk>) {
      const text = contentToText(chunk.content);
      if (text) { synthText += text; yield { type: "token", content: text }; }
    }
    if (synthText) messages.push(new AIMessage(synthText));
    wlog.info({ chars: synthText.length }, "limit synthesis done");
  } catch (err) {
    wlog.error({ err }, "limit synthesis failed");
  }
}

export async function* runAgent(
  messages: BaseMessage[],
  userInput: string,
  workspaceDir: string,
  workspaceId: string,
  { signal, maxIterations = 30, notify, warmContainer, loadConfig, buildAgentTools, containers, store, versioning }: RunAgentOptions = {},
): AsyncGenerator<AgentEvent> {
  const wlog = log.child({ workspaceId });
  const config = (loadConfig ?? loadAgentConfig)();
  const resolvedContainers = containers ?? defaultContainerManager;
  const { modelWithTools, model, toolMap } = (buildAgentTools ?? buildTools)(workspaceId, workspaceDir, config, { containers: resolvedContainers, store });
  const typedToolMap = toolMap as Record<string, AnyTool>;

  const resolvedNotify = notify ?? ((msg: object) => getWsForWorkspace(workspaceId)?.send(JSON.stringify(msg)));
  const resolvedWarmContainer = warmContainer ?? (() => resolvedContainers.ensure(workspaceId, workspaceDir).catch((err: unknown) => { wlog.warn({ err }, "container pre-warm failed"); }));
  // Start spinning up the workspace container while the first LLM call is in flight.
  // ensureContainer is idempotent and coalesces concurrent calls, so execCommand calling
  // it again later is a no-op if the container is already running.
  resolvedWarmContainer();

  messages.push(new HumanMessage(userInput));
  wlog.info({ maxIterations }, "agent run started");

  // Baseline snapshot of the workspace before the run touches anything. Best-effort: a git
  // failure must never block the agent, so it's guarded and logged. The result commit fires in
  // the `finally` below — even on abort/error — capturing whatever the run changed.
  // We keep the baseline sha as the default target for an agent-initiated workspace_restore with
  // no sha ("undo everything I did this run").
  let baselineSha: string | null = null;
  if (versioning) {
    try { baselineSha = (await versioning.commitBaseline(workspaceId, workspaceDir, userInput)).sha; }
    catch (err) { wlog.warn({ err }, "versioning baseline commit failed"); }
  }

  let iterations = 0;
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
        ...(iterations === 1 ? { userInput } : {}),
        ...(reasoningText ? { reasoningText } : {}),
        ...(fullText ? { outputText: fullText } : {}),
      };

      if (!toolCalls.length) {
        // Final text response — tokens already streamed as they arrived; just persist and exit.
        yield { type: "turn_usage", ...usageBase, toolCalls: [] };
        messages.push(new AIMessage(fullText));
        wlog.info("agent run done");
        yield { type: "done" };
        break;
      }

      // Deduplicate: keep only the last of any calls with identical name+args, so every
      // tool_call on the assistant message gets exactly one matching ToolMessage.
      const seen = new Map<string, number>();
      toolCalls.forEach((tc, i) => seen.set(`${tc.name}:${JSON.stringify(tc.args)}`, i));
      const activeCalls = toolCalls.filter((tc, i) => seen.get(`${tc.name}:${JSON.stringify(tc.args)}`) === i);

      const assistantTurn = new AIMessage({
        content: accumulatedChunk?.content ?? fullText,
        tool_calls: activeCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      });

      for (const tc of activeCalls) {
        yield { type: "tool_start", name: tc.name, args: tc.args };
        resolvedNotify({ type: "tool_call", name: tc.name, args: tc.args });
        wlog.debug({ name: tc.name, args: tc.args }, "tool call");
      }

      const settled = await Promise.all(
        activeCalls.map(async (tc) => {
          const tool = typedToolMap[tc.name];
          const toolStart = Date.now();
          const resultStr = tool
            ? await invokeTool(tool, tc.args, signal).catch((err) => `Error: ${String(err)}`)
            : `Error: unknown tool "${tc.name}"`;
          wlog.debug({ name: tc.name, toolMs: Date.now() - toolStart }, "tool timing");
          return { tc, resultStr };
        })
      );

      // Commit the assistant turn and all its tool results in one synchronous block, with no
      // yield or await in between. If the request is aborted (the user hits escape) the runner
      // generator is abandoned at a yield — so it can only ever observe history with either
      // none of this turn or all of it, never an AIMessage whose tool_calls lack their
      // ToolMessages (which OpenAI rejects on the next request).
      messages.push(assistantTurn);
      for (const { tc, resultStr } of settled) {
        messages.push(new ToolMessage({ tool_call_id: tc.id, content: resultStr }));
      }

      for (const { tc, resultStr } of settled) {
        yield { type: "tool_result", name: tc.name, result: resultStr };
        if (tc.name !== "execute_command") {
          resolvedNotify({ type: "tool_result_log", name: tc.name, result: resultStr });
        }
        wlog.debug({ name: tc.name, result: resultStr.slice(0, 200) }, "tool result");
      }

      // Emit usage now that outputs are known, attaching each tool call's result.
      yield {
        type: "turn_usage",
        ...usageBase,
        toolCalls: settled.map(({ tc, resultStr }) => ({ name: tc.name, args: tc.args, output: resultStr, status: classifyToolStatus(resultStr) })),
      };

      // User pressed escape: the tools above have already been killed and their results committed
      // (atomic block, so history stays valid for a later resume). Stop here instead of looping
      // back into another — immediately aborted — model stream. Skip compaction on the way out.
      if (signal?.aborted) {
        wlog.info("agent run aborted by user");
        yield { type: "done" };
        break;
      }

      // Agent-initiated rollback. workspace_restore is a signal only — it can't reach the platform
      // versioning history (deliberately outside the agent's reach), so the runner performs the
      // reset here, AFTER this turn's tools have settled, so it can't race a concurrent file write
      // in the same batch. No sha → the run's pre-run baseline ("undo everything I did this run").
      // Best-effort: a failed/unknown target is logged, never throws into the loop.
      const restoreCall = settled.find(({ tc }) => tc.name === "workspace_restore");
      if (restoreCall && versioning) {
        const target = (restoreCall.tc.args as { sha?: string }).sha ?? baselineSha;
        if (target) {
          try {
            const ok = await versioning.restore(workspaceId, workspaceDir, target);
            if (ok) resolvedNotify({ type: "snapshot_restored", sha: target });
            else wlog.warn({ target }, "agent restore: target snapshot not found");
          } catch (err) {
            wlog.warn({ err, target }, "agent restore failed");
          }
        }
      }

      // Agent-chosen context compaction. The compact_context tool is a signal only — it can't
      // reach `messages`, so the surgery happens here, AFTER this turn's assistant+tool_result
      // pair is committed above (so it's never orphaned: light/medium keep it, hard wipes both
      // together). model is tool-less, so the summarize call can't emit tool calls.
      const compactCall = settled.find(({ tc }) => tc.name === "compact_context");
      if (compactCall) {
        const { level, next_step } = compactCall.tc.args as { level?: CompactLevel; next_step?: string };
        if (level && next_step) {
          await applyCompaction(model, messages, level, next_step);
        }
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
    // no-op run leaves no commit. The snapshot is labelled with the user's prompt (commitResult
    // collapses whitespace and truncates the subject); the actual "what changed" is read from the
    // diff later. Guarded + try/caught so versioning never breaks the run.
    if (versioning) {
      try {
        await versioning.commitResult(workspaceId, workspaceDir, userInput);
      } catch (err) {
        wlog.warn({ err }, "versioning result commit failed");
      }
    }
  }
}
