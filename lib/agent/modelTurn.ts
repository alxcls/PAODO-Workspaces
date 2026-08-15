// Provider-stream adaptation for one model turn. The agent loop consumes normalized token,
// reasoning, tool-call, and usage data without knowing provider-specific chunk shapes.
//
// The stream itself comes from a ModelGateway (./modelGateway.ts), which owns the call and its
// measurement. What is left here is purely the shape of a *turn*: which chunk fields carry prose,
// which carry reasoning, and how a tool call is reassembled from its deltas.
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { Logger } from "pino";
import { throttleLog } from "../infra/logThrottle";
import { newToolCallId } from "./toolCallIds";
import { contentToText } from "@/lib/transcript/content";
import type { AgentEvent } from "./runner";
import type { ModelGateway, ModelUsage } from "./modelGateway";
import {
  classifyProviderCreditExhaustion,
  PROVIDER_CREDIT_EXHAUSTED_CODE,
  providerCreditExhaustedMessage,
} from "./providerCreditFailure";
import { classifyProviderAuthFailure, providerKeyInvalidMessage } from "./providerAuthFailure";

export type ResolvedToolCall = { id: string; name: string; args: Record<string, unknown> };

export type TurnEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  // Carries the turn's measured usage rather than the raw accumulated chunk. The runner has no other
  // use for that chunk — it deliberately persists the coalesced text instead (see runner.ts) — and
  // handing it one invited every consumer to do its own token arithmetic.
  | { type: "turn_complete"; fullText: string; toolCalls: ResolvedToolCall[]; usage: ModelUsage };

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

function assembleToolCalls(partials: PartialToolCall[]): ResolvedToolCall[] {
  const minted = new Set<string>();
  return partials
    .filter((partial) => partial.name)
    .map((partial) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(partial.args || "{}");
      } catch {
        // Malformed provider deltas are surfaced to the tool as empty args.
      }
      // A provider that streams a tool call without an id gets one every provider accepts. The old
      // `tc_<i>_<epoch>` shape had underscores and ran well past 9 characters, and it is replayed on
      // the NEXT turn of this same run — behind the run-start normalization pass, which cannot reach
      // it. So it has to be portable at the moment it is created.
      return { id: partial.id || newToolCallId(minted), name: partial.name, args };
    });
}

export async function* streamModelTurn(
  modelWithTools: ModelGateway,
  messages: BaseMessage[],
  iteration: number,
  signal: AbortSignal | undefined,
  log: Logger,
): AsyncGenerator<TurnEvent> {
  const partials: PartialToolCall[] = [];
  let fullText = "";
  const startedAt = Date.now();
  const call = await modelWithTools.stream(messages, { stage: "model_turn", signal });
  let timeToFirstTokenMs: number | null = null;

  for await (const chunk of call.chunks) {
    if (timeToFirstTokenMs === null) timeToFirstTokenMs = Date.now() - startedAt;
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
  // Read after the loop, where the gateway has finished measuring the drained stream.
  yield { type: "turn_complete", fullText, toolCalls: assembleToolCalls(partials), usage: call.usage() };
}

export async function* synthesizeLimit(
  model: ModelGateway,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
  log: Logger,
  modelId?: string,
): AsyncGenerator<AgentEvent> {
  log.debug("limit synthesis started");
  try {
    const call = await model.stream(
      [
        ...messages,
        new HumanMessage(
          "You have reached the maximum number of steps. Briefly summarize what you accomplished and what still needs to be done. Do not attempt any tool calls.",
        ),
      ],
      { stage: "limit_synthesis", signal },
    );
    const turnId = crypto.randomUUID();
    let text = "";
    for await (const chunk of call.chunks) {
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
        ...call.usage(),
        ...(modelId ? { model: modelId } : {}),
        outputText: text,
        toolCalls: [],
      };
    }
    log.debug({ chars: text.length }, "limit synthesis done");
  } catch (err) {
    // Best-effort by design — the run is already ending on the iteration limit, so a failed summary
    // only costs the closing paragraph. A provider that has stopped accepting the account is the
    // exception, whether because the money ran out or the key stopped being valid mid-run: swallowing
    // either leaves a run that looks merely truncated, with no sign anywhere of why it really ended.
    const creditExhausted = classifyProviderCreditExhaustion(err);
    const keyRefused = creditExhausted ? null : classifyProviderAuthFailure(err);
    if (creditExhausted) {
      yield {
        type: "error",
        code: PROVIDER_CREDIT_EXHAUSTED_CODE,
        message: providerCreditExhaustedMessage(creditExhausted, { model: modelId }),
      };
    } else if (keyRefused) {
      yield { type: "error", code: keyRefused.failureCode, message: providerKeyInvalidMessage(keyRefused) };
    }
    log.error(
      // Carry the classification onto the line this path already logs, so the cause is queryable by
      // the same `failureCode` here as on the main model turn — which reports it separately.
      {
        event: "agent_limit_synthesis_failed",
        outcome: "response_summary_missing",
        err,
        ...creditExhausted,
        ...keyRefused,
      },
      "limit synthesis failed",
    );
  }
}
