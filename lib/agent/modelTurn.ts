// Provider-stream adaptation for one model turn. The agent loop consumes normalized token,
// reasoning, tool-call, and usage data without knowing provider-specific chunk shapes.
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { Logger } from "pino";
import { throttleLog } from "../infra/logThrottle";
import { contentToText } from "@/lib/transcript/content";
import type { AgentEvent } from "./runner";
import {
  classifyProviderCreditExhaustion,
  PROVIDER_CREDIT_EXHAUSTED_CODE,
  providerCreditExhaustedMessage,
} from "./providerCreditFailure";

export type ResolvedToolCall = { id: string; name: string; args: Record<string, unknown> };

export type TurnEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "turn_complete"; fullText: string; toolCalls: ResolvedToolCall[]; accumulatedChunk: AIMessageChunk | null };

type PartialToolCall = { id: string; name: string; args: string };
type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "reasoning"; reasoning?: string }
  | { type: "thinking"; thinking?: string }
  | { type: string };

function extractContentFromChunk(chunk: AIMessageChunk, log: Logger): { tokens: string[]; reasoning: string[] } {
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
        default: {
          const suppressed = throttleLog("agent_content_block_unhandled");
          if (suppressed !== null) {
            log.warn(
              {
                event: "agent_content_block_unhandled",
                outcome: "content_block_ignored",
                blockType: block.type,
                suppressed,
              },
              "unhandled model content block type",
            );
          }
        }
      }
    }
  }
  const reasoningContent = (chunk as unknown as { additional_kwargs?: { reasoning_content?: string } })
    .additional_kwargs?.reasoning_content;
  if (reasoningContent) reasoning.push(reasoningContent);
  return { tokens, reasoning };
}

export function usageTokens(chunk: AIMessageChunk | null) {
  return {
    inputTokensTotal: chunk?.usage_metadata?.input_tokens ?? 0,
    outputTokensTotal: chunk?.usage_metadata?.output_tokens ?? 0,
    outputTokensReasoning: chunk?.usage_metadata?.output_token_details?.reasoning ?? 0,
    inputTokensCacheRead:
      chunk?.usage_metadata?.input_token_details?.cache_read ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chunk?.response_metadata as any)?.usage?.prompt_cache_hit_tokens ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chunk?.response_metadata as any)?.usage?.cached_tokens ??
      0,
    inputTokensCacheWrite: chunk?.usage_metadata?.input_token_details?.cache_creation ?? 0,
  };
}

function assembleToolCalls(partials: PartialToolCall[]): ResolvedToolCall[] {
  return partials
    .filter((partial) => partial.name)
    .map((partial, index) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(partial.args || "{}");
      } catch {
        // Malformed provider deltas are surfaced to the tool as empty args.
      }
      return { id: partial.id || `tc_${index}_${Date.now()}`, name: partial.name, args };
    });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function* streamModelTurn(
  modelWithTools: any,
  messages: BaseMessage[],
  iteration: number,
  signal: AbortSignal | undefined,
  log: Logger,
): AsyncGenerator<TurnEvent> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const partials: PartialToolCall[] = [];
  let fullText = "";
  let accumulatedChunk: AIMessageChunk | null = null;
  const startedAt = Date.now();
  const stream = await modelWithTools.stream(messages, { signal });
  let timeToFirstTokenMs: number | null = null;

  for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
    if (timeToFirstTokenMs === null) timeToFirstTokenMs = Date.now() - startedAt;
    accumulatedChunk = accumulatedChunk ? accumulatedChunk.concat(chunk) : chunk;
    const { tokens, reasoning } = extractContentFromChunk(chunk, log);
    for (const content of tokens) {
      fullText += content;
      yield { type: "token", content };
    }
    for (const content of reasoning) yield { type: "reasoning", content };

    for (const delta of chunk.tool_call_chunks ?? []) {
      const index = delta.index ?? 0;
      if (!partials[index]) partials[index] = { id: "", name: "", args: "" };
      if (delta.id) partials[index].id = delta.id;
      if (delta.name) partials[index].name += delta.name;
      if (delta.args) partials[index].args += delta.args;
    }
  }

  log.debug({ iteration, ttftMs: timeToFirstTokenMs, streamMs: Date.now() - startedAt }, "model stream timing");
  yield { type: "turn_complete", fullText, toolCalls: assembleToolCalls(partials), accumulatedChunk };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function* synthesizeLimit(
  model: any,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
  log: Logger,
  modelId?: string,
): AsyncGenerator<AgentEvent> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  log.debug("limit synthesis started");
  try {
    const stream = await model.stream(
      [
        ...messages,
        new HumanMessage(
          "You have reached the maximum number of steps. Briefly summarize what you accomplished and what still needs to be done. Do not attempt any tool calls.",
        ),
      ],
      { signal },
    );
    const turnId = crypto.randomUUID();
    let text = "";
    let accumulatedChunk: AIMessageChunk | null = null;
    for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
      accumulatedChunk = accumulatedChunk ? accumulatedChunk.concat(chunk) : chunk;
      const content = contentToText(chunk.content);
      if (content) {
        text += content;
        yield { type: "token", content };
      }
    }
    if (text) {
      messages.push(new AIMessage({ content: text, response_metadata: { executionTurnId: turnId } }));
      yield {
        type: "turn_usage",
        turnId,
        ...usageTokens(accumulatedChunk),
        ...(modelId ? { model: modelId } : {}),
        outputText: text,
        toolCalls: [],
      };
    }
    log.debug({ chars: text.length }, "limit synthesis done");
  } catch (err) {
    // Best-effort by design — the run is already ending on the iteration limit, so a failed summary
    // only costs the closing paragraph. An out-of-credit provider is the exception: swallowing it
    // here leaves a run that looks merely truncated, with no sign anywhere that the account is dry.
    const creditExhausted = classifyProviderCreditExhaustion(err);
    if (creditExhausted) {
      yield {
        type: "error",
        code: PROVIDER_CREDIT_EXHAUSTED_CODE,
        message: providerCreditExhaustedMessage(creditExhausted, { model: modelId }),
      };
    }
    log.error(
      // Carry the classification onto the line this path already logs, so a dry account is queryable
      // by the same `failureCode` here as on the main model turn — which reports it separately.
      { event: "agent_limit_synthesis_failed", outcome: "response_summary_missing", err, ...creditExhausted },
      "limit synthesis failed",
    );
  }
}
