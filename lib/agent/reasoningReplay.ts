// A turn's reasoning, kept on the turn for every provider: it is shown again when the conversation
// is reopened, and replayed to the providers that reject a thinking-mode turn without it.
import type { AIMessage } from "@langchain/core/messages";

/** The providers that are sent reasoning back. modelGateway.ts must hold an adapter for each. */
export const REPLAYING_PROVIDERS = ["mistral", "deepseek"] as const;
export type ReplayingProvider = (typeof REPLAYING_PROVIDERS)[number];

/**
 * Private to this module: the whole point is that no caller reaches for the keys themselves.
 *
 * A raw string is stored, never a vendor's encoding — Mistral rebuilds its ThinkChunks and DeepSeek
 * its reasoning_content from this at the outbound boundary, so neither spelling reaches the runner.
 * The name predates storing it for display; it stays so saved conversations keep reading.
 */
const REPLAY_REASONING_KEY = "replayReasoning";
const REASONING_PROVIDER_KEY = "reasoningProvider";

/**
 * Add a turn's reasoning to response metadata, leaving canonical content untouched.
 *
 * `response_metadata` rather than the message body because it round-trips through
 * messageSerialization.ts and is never sent to a provider — the same seam executionTurnId already
 * rides on. `provider` is who reasoned, so nobody else is handed it as their own. A turn that
 * produced no reasoning stores nothing.
 */
export function withReplayMetadata(
  metadata: Record<string, unknown>,
  reasoning: string,
  provider?: string,
): Record<string, unknown> {
  if (!reasoning) return metadata;
  return { ...metadata, [REPLAY_REASONING_KEY]: reasoning, ...(provider && { [REASONING_PROVIDER_KEY]: provider }) };
}

/**
 * A message's stored reasoning, or "" when it has none. For display and tracing, whoever wrote it.
 *
 * Non-strings read as absent, which is what makes this safe against history written before the key
 * held a plain string.
 */
export function storedReasoning(message: AIMessage): string {
  const value = message.response_metadata?.[REPLAY_REASONING_KEY];
  return typeof value === "string" ? value : "";
}

/**
 * The reasoning to send back for this turn, or "" when there is none to send.
 *
 * Exactly what was replayed before every provider's reasoning was stored: a turn a replaying
 * provider wrote, or one with no recorded author, which predates the label and can only be theirs.
 * Reasoning kept purely for display, such as Claude's, never reaches another model.
 */
export function replayReasoning(message: AIMessage): string {
  const author = message.response_metadata?.[REASONING_PROVIDER_KEY];
  const replayable = typeof author !== "string" || (REPLAYING_PROVIDERS as readonly string[]).includes(author);
  return replayable ? storedReasoning(message) : "";
}
