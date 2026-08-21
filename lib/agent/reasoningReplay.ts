// Capturing a turn's reasoning so the next request can replay it. Several providers reject a
// thinking-mode turn whose reasoning is missing, and they disagree only about the wire shape.
import type { AIMessage } from "@langchain/core/messages";

/**
 * Private to this module: the whole point is that no caller reaches for the key itself.
 *
 * A raw string is stored, never a vendor's encoding — Mistral rebuilds its ThinkChunks and DeepSeek
 * its reasoning_content from this at the outbound boundary, so neither spelling reaches the runner.
 */
const REPLAY_REASONING_KEY = "replayReasoning";

/**
 * Add a turn's reasoning to response metadata, leaving canonical content untouched.
 *
 * `response_metadata` rather than the message body because it round-trips through
 * messageSerialization.ts and is ignored by every provider adapter that has not opted in — the same
 * seam executionTurnId already rides on. A turn that produced no reasoning stores nothing.
 */
export function withReplayMetadata(
  metadata: Record<string, unknown>,
  reasoning: string,
): Record<string, unknown> {
  return reasoning ? { ...metadata, [REPLAY_REASONING_KEY]: reasoning } : metadata;
}

/**
 * A message's stored reasoning, or "" when it has none.
 *
 * Non-strings read as absent, which is what makes this safe against history written before the key
 * held a plain string. Such a turn replays without its reasoning rather than throwing.
 */
export function replayReasoning(message: AIMessage): string {
  const value = message.response_metadata?.[REPLAY_REASONING_KEY];
  return typeof value === "string" ? value : "";
}
