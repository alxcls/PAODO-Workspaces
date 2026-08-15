// The vocabulary of "which model, how hard should it think" — chosen in the UI, stored on the
// workspace record, and read back by operations, persistence, and the agent alike.
//
// This lives in models/ rather than agent/ because the workspace *entity* carries a selection
// (lib/workspace/types.ts) and the registry persists one (lib/infra/workspace/registry.ts); neither
// should have to reach into the agent runtime for the type of one of its own fields. The agent
// consumes this vocabulary — it does not own it. The resolved per-run config that the runtime builds
// *from* a selection is a different thing and stays in lib/agent/interfaces.ts (LLMProviderConfig).

// The full set of reasoning-effort levels across all providers, quietest first. Each provider accepts
// only a SUBSET (see PROVIDER_METADATA in lib/agent/buildModel.ts): OpenAI takes none…xhigh, Anthropic
// low…max, DeepSeek none. A stored/selected value is validated against the chosen provider's subset,
// not this union — so this type is deliberately the widest thing any provider might carry.
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Per-workspace LLM selection: provider + model + reasoning effort are chosen in the UI and stored on
// the workspace record (not in .env). A workspace that has made no choice gets defaultModelSelection()
// (lib/agent/buildModel.ts) — the first provider .env leaves switched on, not a hardcoded one.
// There is deliberately no default-selection constant here: one would have to be kept in sync with
// what .env actually allows, and would name a provider the deployment may have switched off.
//
// Note this is about the CHOICE, not about whether it can run. Whether the chosen provider has an API
// key is a separate question, answered from the encrypted key store at the start of a run.
//
// The reasoning effort stored for a provider that has no effort dial. Never sent to the provider —
// the field is not nullable, so it holds one uniform value instead of whatever the last dial-having
// provider was left on.
export const NO_DIAL_EFFORT: ReasoningEffort = "low";

/**
 * How "thinking off" is stored: a `toggle` provider with its box unchecked runs at effort "none".
 *
 * This is why a `toggle` provider must offer "none" in its reasoningEfforts — there would
 * otherwise be no storable representation of the unchecked state. lib/models/registry.test.ts
 * asserts that invariant across every provider so a future model can't quietly violate it.
 */
export const THINKING_OFF_EFFORT: ReasoningEffort = "none";
