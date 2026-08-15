// Everything Mistral requires that no other provider should inherit. Canonical conversation
// messages stay provider-neutral; this module adapts a short-lived clone at the outbound boundary.
import { createHash } from "node:crypto";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { isMistralToolCallId, newMistralToolCallId } from "./toolCallIds";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "../models/llmSelection";

const REPLAY_CONTENT_KEY = "mistralReplayContent";

type MistralTextChunk = { type: "text"; text: string };
type MistralThinkChunk = { type: "thinking"; thinking: MistralTextChunk[] };
export type MistralReplayContent = Array<MistralThinkChunk | MistralTextChunk>;

/** Medium supports optional high reasoning; Large accepts no reasoning field. */
export function mistralReasoningConfig(
  model: string,
  effort: ReasoningEffort,
): { modelKwargs?: { reasoning_effort: "high" } } {
  return model === "mistral-medium-latest" && effort !== THINKING_OFF_EFFORT
    ? { modelKwargs: { reasoning_effort: "high" } }
    : {};
}

/** A provider-valid id derived from the canonical id, stable across requests for prompt caching. */
function translatedId(id: string, taken: Set<string>): string {
  for (let salt = 0; ; salt++) {
    const candidate = createHash("sha256").update(`${id}:${salt}`).digest("hex").slice(0, 9);
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Build the mapping once so each assistant call and its ToolMessage receive the same translated id. */
function mistralIdMap(messages: BaseMessage[]): Map<string, string> {
  const taken = new Set<string>();
  for (const message of messages) {
    if (message instanceof AIMessage) {
      for (const call of message.tool_calls ?? []) {
        if (call.id && isMistralToolCallId(call.id)) taken.add(call.id);
      }
    } else if (message instanceof ToolMessage && isMistralToolCallId(message.tool_call_id)) {
      // Even an orphan is part of the request. Reserve it so a translated pair cannot collide with it.
      taken.add(message.tool_call_id);
    }
  }

  const ids = new Map<string, string>();
  const add = (id: string | undefined) => {
    if (!id || isMistralToolCallId(id) || ids.has(id)) return;
    ids.set(id, translatedId(id, taken));
  };
  for (const message of messages) {
    if (message instanceof AIMessage) {
      for (const call of message.tool_calls ?? []) add(call.id);
    } else if (message instanceof ToolMessage) {
      add(message.tool_call_id);
    }
  }
  return ids;
}

function replayContent(message: AIMessage): MistralReplayContent | undefined {
  const value = message.response_metadata?.[REPLAY_CONTENT_KEY];
  return Array.isArray(value) ? (value as MistralReplayContent) : undefined;
}

/**
 * Clone only Mistral-sensitive messages, restoring its private thinking and translating foreign ids.
 * The caller's array and messages are never mutated; every other provider receives those originals.
 */
export function prepareMistralMessages(messages: BaseMessage[]): BaseMessage[] {
  const ids = mistralIdMap(messages);
  return messages.map((message) => {
    if (message instanceof AIMessage) {
      const content = replayContent(message) ?? message.content;
      const toolCalls = (message.tool_calls ?? []).map((call) => ({
        ...call,
        ...(call.id && ids.has(call.id) ? { id: ids.get(call.id)! } : {}),
      }));
      if (content === message.content && toolCalls.every((call, i) => call.id === message.tool_calls?.[i]?.id)) {
        return message;
      }
      return new AIMessage({
        content: content as never,
        tool_calls: toolCalls,
        invalid_tool_calls: message.invalid_tool_calls,
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
        usage_metadata: message.usage_metadata,
        name: message.name,
        id: message.id,
      });
    }
    if (message instanceof ToolMessage && ids.has(message.tool_call_id)) {
      return new ToolMessage({
        content: message.content,
        tool_call_id: ids.get(message.tool_call_id)!,
        artifact: message.artifact,
        status: message.status,
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
        name: message.name,
        id: message.id,
      });
    }
    return message;
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

/** Add Mistral replay state to response metadata without changing the canonical message content. */
export function withMistralReplayMetadata(
  metadata: Record<string, unknown>,
  content: MistralReplayContent | undefined,
): Record<string, unknown> {
  return content ? { ...metadata, [REPLAY_CONTENT_KEY]: content } : metadata;
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

/** A missing id is rare but still must satisfy Mistral before the result is replayed next turn. */
export function providerToolCallId(provider: string, id: string, taken: Set<string>): string {
  return id || (provider === "mistral" ? newMistralToolCallId(taken) : crypto.randomUUID());
}
