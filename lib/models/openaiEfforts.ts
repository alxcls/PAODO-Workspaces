/**
 * The `reasoning.effort` levels each OpenAI model accepts, transcribed from its model page.
 *
 * Per model since GPT-5.6: that family added `max` and dropped `minimal`, and the always-reasoning
 * GPT-6 models do not support `none` either.
 *
 * Every offered model has an entry (lib/models/registry.test.ts asserts it), so the provider-wide
 * union below is never what a real model is offered.
 */
import { effortUnion, type ReasoningEffort } from "./llmSelection";

const GPT_5_EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const WITH_MAX_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
// These always reason: OpenAI's guidance for a caller that used to send `none` is `low`.
const ALWAYS_REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Keyed by the model id in lib/models/registry.ts. */
export const OPENAI_MODEL_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  "gpt-5": GPT_5_EFFORTS,
  "gpt-5.1": GPT_5_EFFORTS,
  "gpt-5.4": GPT_5_EFFORTS,
  "gpt-5.5": GPT_5_EFFORTS,
  "gpt-5.5-pro": GPT_5_EFFORTS,
  "gpt-5.6-luna": WITH_MAX_EFFORTS,
  "gpt-5.6-terra": WITH_MAX_EFFORTS,
  "gpt-5.6-sol": WITH_MAX_EFFORTS,
  "gpt-6-luna": WITH_MAX_EFFORTS,
  "gpt-6-sol": WITH_MAX_EFFORTS,
  "gpt-6.1-sol": ALWAYS_REASONING_EFFORTS,
  "gpt-6-astra": ALWAYS_REASONING_EFFORTS,
};

/** The table as the plain model→levels map the vocabulary and the catalog API carry. */
export function openaiModelEffortLists(): Record<string, readonly ReasoningEffort[]> {
  return { ...OPENAI_MODEL_EFFORTS };
}

/** Every level any offered OpenAI model accepts, quietest first. */
export function openaiProviderEfforts(): ReasoningEffort[] {
  return effortUnion(Object.values(OPENAI_MODEL_EFFORTS));
}
