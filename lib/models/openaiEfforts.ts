/**
 * The `reasoning.effort` levels each OpenAI model accepts, transcribed from its model page.
 *
 * No two generations agree: only GPT-5 takes `minimal`, `xhigh` starts at GPT-5.4 and `max` at
 * GPT-5.6. GPT-5, GPT-5.5 Pro and the always-reasoning GPT-6 models do not support `none`.
 *
 * Every offered model has an entry (lib/models/registry.test.ts asserts it), so the provider-wide
 * union below is never what a real model is offered.
 */
import { effortUnion, type ReasoningEffort } from "./llmSelection";

const WITH_XHIGH_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];
const WITH_MAX_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
// These always reason: OpenAI's guidance for a caller that used to send `none` is `low`.
const ALWAYS_REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Keyed by the model id in lib/models/registry.ts. */
export const OPENAI_MODEL_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  "gpt-5": ["minimal", "low", "medium", "high"],
  "gpt-5.1": ["none", "low", "medium", "high"],
  "gpt-5.4": WITH_XHIGH_EFFORTS,
  "gpt-5.5": WITH_XHIGH_EFFORTS,
  "gpt-5.5-pro": ["medium", "high", "xhigh"],
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
