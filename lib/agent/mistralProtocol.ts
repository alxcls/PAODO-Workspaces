// Everything Mistral requires that no other provider should inherit. Canonical conversation
// messages stay provider-neutral; this module adapts a short-lived clone at the outbound boundary.
import { AIMessage, type BaseMessage, type BaseMessageChunk } from "@langchain/core/messages";
import { ChatOpenAI, ChatOpenAICompletions, type ChatOpenAIFields } from "@langchain/openai";
import { replayReasoning } from "./reasoningReplay";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "../models/llmSelection";

type MistralTextChunk = { type: "text"; text: string };
type MistralThinkChunk = { type: "thinking"; thinking: MistralTextChunk[] };
export type MistralReplayContent = Array<MistralThinkChunk | MistralTextChunk>;

type MistralReasoningEffort = "high" | "none";

/** Mistral reasoning is on/off. Off is sent explicitly: measured, Large 4 reasons when the field is absent. */
function mistralReasoningConfig(effort: ReasoningEffort): { modelKwargs: { reasoning_effort: MistralReasoningEffort } } {
  return { modelKwargs: { reasoning_effort: effort === THINKING_OFF_EFFORT ? "none" : "high" } };
}

/**
 * Mistral-only request fields. The caller supplies a provider-neutral conversation scope; this is
 * the boundary that turns it into Mistral's prompt_cache_key. Keeping the key stable lets each
 * ReAct turn reuse the unchanged prefix from the previous turn.
 *
 * The key rides the typed `promptCacheKey` field, NOT modelKwargs: ChatOpenAI writes
 * `prompt_cache_key` from that field AFTER spreading modelKwargs, so a key placed in modelKwargs is
 * overwritten with undefined and dropped from the body — cached silently, never actually sent.
 */
export function mistralRequestConfig(
  effort: ReasoningEffort,
  cacheScopeId?: string,
): { modelKwargs: { reasoning_effort: MistralReasoningEffort }; promptCacheKey?: string } {
  return {
    ...mistralReasoningConfig(effort),
    ...(cacheScopeId ? { promptCacheKey: cacheScopeId } : {}),
  };
}

/**
 * Flatten one streamed Mistral delta into the shape ChatOpenAI's completions path accepts.
 *
 * Mistral streams reasoning as content blocks (`content: [{ type: "thinking", ... }]`). That path
 * yields only deltas whose content is a string: anything else is logged as
 * "[WARNING]: Received non-string content from OpenAI" and skipped, taking the tokens with it.
 *
 * So the prose stays in `content` and the thinking moves to `reasoning_content` — the field the turn
 * reader already reads for reasoning providers — leaving nothing for that check to discard.
 */
export function flattenMistralDelta(delta: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(delta.content)) return delta;
  const text: string[] = [];
  const thinking: string[] = [];
  for (const part of delta.content) {
    if (typeof part === "string") {
      text.push(part);
    } else if (part && typeof part === "object") {
      const block = part as { type?: string; text?: unknown; thinking?: unknown };
      if (block.type === "thinking") thinking.push(mistralThinkingText(block.thinking));
      else if (typeof block.text === "string") text.push(block.text);
    }
  }
  const carried = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
  const reasoning = carried + thinking.join("");
  return { ...delta, content: text.join(""), ...(reasoning ? { reasoning_content: reasoning } : {}) };
}

// The hook is deprecated upstream ("overridable ... removed in a future release"), so its removal
// must fail loudly: mistralProtocol.test.ts streams a thinking delta through a real model instance.
class MistralCompletions extends ChatOpenAICompletions {
  protected _convertCompletionsDeltaToBaseMessageChunk(
    delta: Record<string, unknown>,
    ...rest: [rawResponse: never, defaultRole?: never]
  ): BaseMessageChunk {
    return super._convertCompletionsDeltaToBaseMessageChunk(flattenMistralDelta(delta), ...rest);
  }
}

/**
 * A ChatOpenAI whose streaming half understands Mistral's content blocks.
 *
 * ChatOpenAI delegates every completions call to the instance it is handed, so injecting the
 * subclass adapts the inbound wire format without a second client or a forked call path.
 */
export function createMistralChatModel(fields: ChatOpenAIFields): ChatOpenAI {
  return new ChatOpenAI({ ...fields, completions: new MistralCompletions(fields) });
}

/**
 * The stored reasoning as Mistral's content blocks, or nothing for a turn that did not reason.
 *
 * Built here rather than at capture time so the runner stores one provider-neutral string
 * (reasoningReplay.ts) instead of this vendor's shape. Text comes straight off the message, which is
 * why nothing but the reasoning has to be carried across turns.
 */
function replayContent(message: AIMessage): MistralReplayContent | undefined {
  // Non-string content is already blocks. Rebuilding from it would drop everything the "" fallback
  // could not represent, so such a message goes out exactly as the caller wrote it.
  if (typeof message.content !== "string") return undefined;
  return mistralReplayContent(replayReasoning(message), message.content);
}

/**
 * Clone only the assistant turns that reasoned, restoring their thinking as Mistral's content blocks.
 * The caller's array and messages are never mutated; every other provider receives those originals.
 */
export function prepareMistralMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (!(message instanceof AIMessage)) return message;
    const content = replayContent(message);
    if (!content) return message;
    return new AIMessage({
      content: content as never,
      tool_calls: message.tool_calls,
      invalid_tool_calls: message.invalid_tool_calls,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      usage_metadata: message.usage_metadata,
      name: message.name,
      id: message.id,
    });
  });
}

/** The private replay payload stored beside provider-neutral text, or nothing for non-reasoning turns. */
export function mistralReplayContent(reasoning: string, text: string): MistralReplayContent | undefined {
  if (!reasoning) return undefined;
  return [
    { type: "thinking", thinking: [{ type: "text", text: reasoning }] },
    ...(text ? ([{ type: "text", text }] as MistralTextChunk[]) : []),
  ];
}

/** Mistral's nested ThinkChunk text; its OpenAI-compatible stream does not use Anthropic's string. */
export function mistralThinkingText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}
