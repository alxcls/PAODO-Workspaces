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
// (lib/operations/models/catalog.ts) — the first provider .env makes available, not a hardcoded one.
// There is deliberately no default-selection constant here: one would have to be kept in sync with
// what .env actually allows, and would name a provider the deployment may have switched off.
//
// The reasoning effort stored for a provider that has no effort dial. Never sent to the provider —
// the field is not nullable, so it holds one uniform value instead of whatever the last dial-having
// provider was left on.
export const NO_DIAL_EFFORT: ReasoningEffort = "low";

/**
 * Whether a MODEL thinks, and whether the caller gets a say. Model-level rather than provider-level
 * because providers are no longer uniform: Mistral offers models that take a thinking switch
 * (mistral-small-4, mistral-medium-3.5), models that always think and REJECT the switch with a 400
 * (the magistral pair), and models that never think (devstral, codestral, ministral) — all under one
 * provider id, so `reasoningEfforts` alone can't describe them.
 *
 * - `toggle` — thinking can be turned on and off. The picker shows an interactive checkbox.
 * - `always` — the model always thinks and offers no way to stop it. The picker shows the checkbox
 *   checked and disabled, because "on" is the truth and pretending it's a choice would be a lie.
 * - `never`  — the model has no thinking mode. The picker shows no checkbox at all.
 *
 * Each model is classified by what the app ALREADY does with it today, not by what the vendor's API
 * might additionally permit. Anthropic and Moonshot models are `always` because buildModel
 * unconditionally sends a thinking config for them; reclassifying one as `toggle` is a deliberate
 * behavior change to that provider, not a relabelling.
 */
export type ThinkingSupport = "never" | "toggle" | "always";

/**
 * How "thinking off" is stored: a `toggle` model with its box unchecked runs at effort "none".
 *
 * This is why a `toggle` model's provider must offer "none" in its reasoningEfforts — there would
 * otherwise be no storable representation of the unchecked state. lib/models/registry.test.ts
 * asserts that invariant across every provider so a future model can't quietly violate it.
 */
export const THINKING_OFF_EFFORT: ReasoningEffort = "none";
