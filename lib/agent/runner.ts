// Drives the agent's agentic loop: streams every model turn, collecting text tokens
// and tool-call chunks simultaneously, then dispatches tools and loops until a turn
// arrives with neither native nor inline tool calls.
// Set DEBUG=1 in the environment to enable verbose tool call logging.
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { Logger } from "pino";
import { buildTools, loadAgentConfig } from "./tools";
import type { AgentConfig } from "./tools/interfaces";
import { defaultContainerManager } from "../infra/containerManager";
import type { IContainerManager, IWorkspaceStore } from "../infra/interfaces";
import { getWsForWorkspace } from "../infra/wsHub";
import { createLogger } from "../infra/logger";

const log = createLogger("agent");

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "error"; message: string }
  | { type: "limit_reached" }
  | { type: "done" };

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
};

// The injectable infra pair, threaded from the route layer (via getStore()/getContainers())
// down through agentStream and nested agent-to-agent calls so a single setServices() swap
// flows end-to-end. Kept separate from RunAgentOptions so callers that only forward infra
// don't have to know about the test-only override seams.
export type AgentRuntimeDeps = Pick<RunAgentOptions, "store" | "containers">;

type AnyTool = { invoke: (args: Record<string, unknown>) => Promise<unknown> };
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

async function invokeTool(tool: AnyTool, args: Record<string, unknown>): Promise<string> {
  const result = await tool.invoke(args);
  const str = String(result);
  return str.length > MAX_RESULT_CHARS
    ? str.slice(0, MAX_RESULT_CHARS) + `\n\n[output truncated — ${str.length} chars total, showing first ${MAX_RESULT_CHARS}]`
    : str;
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
  { signal, maxIterations = 30, notify, warmContainer, loadConfig, buildAgentTools, containers, store }: RunAgentOptions = {},
): AsyncGenerator<AgentEvent> {
  const wlog = log.child({ workspaceId });
  const config = (loadConfig ?? loadAgentConfig)();
  const resolvedContainers = containers ?? defaultContainerManager;
  const { modelWithTools, model, toolMap } = (buildAgentTools ?? buildTools)(workspaceId, workspaceDir, config, { containers: resolvedContainers, store });
  const typedToolMap = toolMap as Record<string, AnyTool>;

  const resolvedNotify = notify ?? ((msg: object) => getWsForWorkspace(workspaceId)?.send(JSON.stringify(msg)));
  const resolvedWarmContainer = warmContainer ?? (() => resolvedContainers.ensure(workspaceId, workspaceDir).catch(() => {}));
  // Start spinning up the workspace container while the first LLM call is in flight.
  // ensureContainer is idempotent and coalesces concurrent calls, so execCommand calling
  // it again later is a no-op if the container is already running.
  resolvedWarmContainer();

  messages.push(new HumanMessage(userInput));
  wlog.info({ maxIterations }, "agent run started");

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
      let toolCalls: ResolvedToolCall[] = [];
      let accumulatedChunk: AIMessageChunk | null = null;

      for await (const event of streamModelTurn(modelWithTools, messages, iterations, signal, wlog)) {
        if (event.type === "turn_complete") {
          fullText = event.fullText;
          toolCalls = event.toolCalls;
          accumulatedChunk = event.accumulatedChunk;
        } else {
          yield event;
        }
      }

      if (!toolCalls.length) {
        // Final text response — tokens already streamed as they arrived; just persist and exit.
        messages.push(new AIMessage(fullText));
        wlog.info("agent run done");
        yield { type: "done" };
        break;
      }

      // Deduplicate: keep only the last of any calls with identical name+args.
      // Done before pushing the AIMessage so every tool_call_id gets a ToolMessage.
      const seen = new Map<string, number>();
      toolCalls.forEach((tc, i) => seen.set(`${tc.name}:${JSON.stringify(tc.args)}`, i));
      const activeCalls = toolCalls.filter((tc, i) => seen.get(`${tc.name}:${JSON.stringify(tc.args)}`) === i);

      messages.push(new AIMessage({
        content: accumulatedChunk?.content ?? fullText,
        tool_calls: activeCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      }));

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
            ? await invokeTool(tool, tc.args).catch((err) => `Error: ${String(err)}`)
            : `Error: unknown tool "${tc.name}"`;
          wlog.debug({ name: tc.name, toolMs: Date.now() - toolStart }, "tool timing");
          return { tc, resultStr };
        })
      );

      for (const { tc, resultStr } of settled) {
        yield { type: "tool_result", name: tc.name, result: resultStr };
        if (tc.name !== "execute_command") {
          resolvedNotify({ type: "tool_result_log", name: tc.name, result: resultStr });
        }
        wlog.debug({ name: tc.name, result: resultStr.slice(0, 200) }, "tool result");
        messages.push(new ToolMessage({ tool_call_id: tc.id, content: resultStr }));
      }
    }
  } catch (err) {
    // Remove any dangling assistant turn with unanswered tool_calls so future
    // requests don't fail with the "tool_call_id must be followed by tool messages" error.
    const last = messages[messages.length - 1];
    if (last instanceof AIMessage && last.tool_calls?.length) messages.pop();
    wlog.error({ err }, "agent run failed");
    yield { type: "error", message: String(err) };
    yield { type: "done" };
  }
}
