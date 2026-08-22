// Everything Scaleway requires that no other provider should inherit: it spells reasoning with a
// different field name than the SDK reads, and it accepts effort levels its models do not honour.
import { ChatOpenAI, ChatOpenAICompletions, type ChatOpenAIFields } from "@langchain/openai";
import type { BaseMessage, BaseMessageChunk } from "@langchain/core/messages";
import { SCALEWAY_MODEL_EFFORTS } from "../models/scalewayEfforts";
import type { ReasoningEffort } from "../models/llmSelection";

/**
 * The effort to actually send for a model, given the level the workspace selected.
 *
 * A level the model does not support is replaced with that model's documented default rather than
 * passed through. Scaleway's gateway would accept it — it validates against vLLM's union, not the
 * model — and then collapse it to the default anyway, so this only makes the request say what is
 * really going to happen. Both offered models support "none", so switching thinking off always works.
 *
 * A model absent from the table is sent the level unchanged; there is nothing better to guess.
 */
export function scalewayEffort(model: string, effort: ReasoningEffort): ReasoningEffort {
  const entry = SCALEWAY_MODEL_EFFORTS[model];
  if (!entry) return effort;
  return entry.supported.includes(effort) ? effort : entry.fallback;
}

/** Scaleway's own documented dial. Raw because "none" is not in the SDK's typed effort union. */
export function scalewayReasoningConfig(
  model: string,
  effort: ReasoningEffort,
): { modelKwargs: { reasoning_effort: ReasoningEffort } } {
  return { modelKwargs: { reasoning_effort: scalewayEffort(model, effort) } };
}

/**
 * Rename Scaleway's reasoning field to the one the SDK reads.
 *
 * Scaleway streams thinking as `reasoning` (and returns `message.reasoning` unstreamed), while
 * @langchain/openai only ever looks at `reasoning_content` — so left alone the whole reasoning
 * stream is billed, then dropped before lib/agent/modelTurn.ts can see it. Both models reason by
 * default, so this is the normal path rather than an edge case.
 *
 * An already-present `reasoning_content` wins: if Scaleway ever adopts the standard spelling, this
 * must not overwrite it with the legacy field.
 */
export function renameScalewayReasoning<T extends object>(payload: T): T {
  const { reasoning, reasoning_content } = payload as ScalewayReasoningFields;
  if (typeof reasoning !== "string" || typeof reasoning_content === "string") return payload;
  return { ...payload, reasoning_content: reasoning };
}

/** The two spellings, as they appear on both a streamed delta and a whole message. */
interface ScalewayReasoningFields {
  reasoning?: unknown;
  reasoning_content?: unknown;
}

/**
 * Both hooks are overridden because the app uses both call shapes: modelTurn streams a run's turns,
 * while modelGateway.invoke serves the non-streaming paths (compaction, summaries).
 *
 * NOT covered, because Scaleway does not report it: reasoning TOKENS. Its usage payload carries no
 * `completion_tokens_details` at all, so outputTokensReasoning stays 0 for these models however much
 * reasoning text arrives. The tokens are still counted in `completion_tokens`, so no cost is lost.
 */
class ScalewayCompletions extends ChatOpenAICompletions {
  protected _convertCompletionsDeltaToBaseMessageChunk(
    delta: Record<string, unknown>,
    ...rest: [rawResponse: never, defaultRole?: never]
  ): BaseMessageChunk {
    return super._convertCompletionsDeltaToBaseMessageChunk(renameScalewayReasoning(delta), ...rest);
  }

  protected _convertCompletionsMessageToBaseMessage(
    message: ScalewayReasoningFields & { role: "assistant" },
    ...rest: [rawResponse: never]
  ): BaseMessage {
    // Cast because the base signature names OpenAI's ChatCompletionMessage, a type this repo has no
    // direct dependency on. The rename preserves every field, so the shape reaching super is unchanged.
    const restored = renameScalewayReasoning(message) as typeof message;
    return super._convertCompletionsMessageToBaseMessage(restored as never, ...rest);
  }
}

/**
 * A ChatOpenAI whose inbound half understands Scaleway's field name.
 *
 * ChatOpenAI delegates every completions call to the instance it is handed, so injecting the
 * subclass adapts the wire format without a second client or a forked call path — the same seam
 * ./mistralProtocol.ts uses for that vendor's content blocks.
 */
export function createScalewayChatModel(fields: ChatOpenAIFields): ChatOpenAI {
  return new ChatOpenAI({ ...fields, completions: new ScalewayCompletions(fields) });
}
