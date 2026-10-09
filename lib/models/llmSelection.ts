/**
 * The vocabulary of "which model, how hard should it think" — chosen in the UI, stored on the
 * workspace record, and read back by operations, persistence, and the agent alike.
 *
 * This lives in models/ rather than agent/ because the workspace *entity* carries a selection
 * (lib/workspace/types.ts) and the registry persists one (lib/infra/workspace/registry.ts); neither
 * should have to reach into the agent runtime for the type of one of its own fields. The agent
 * consumes this vocabulary — it does not own it. The resolved per-run config that the runtime builds
 * *from* a selection is a different thing and stays in lib/agent/interfaces.ts (LLMProviderConfig).
 *
 * Per-workspace LLM selection: provider + model + reasoning effort are chosen in the UI and stored on
 * the workspace record (not in .env). A workspace that has made no choice gets defaultModelSelection()
 * (lib/agent/buildModel.ts) — the first provider .env leaves switched on, not a hardcoded one.
 * There is deliberately no default-selection constant here: one would have to be kept in sync with
 * what .env actually allows, and would name a provider the deployment may have switched off.
 *
 * Note this is about the CHOICE, not about whether it can run. Whether the chosen provider has an API
 * key is a separate question, answered from the encrypted key store at the start of a run.
 */

/**
 * The full set of reasoning-effort levels across all models, quietest first. Each MODEL accepts only
 * a subset (see PROVIDERS in lib/agent/buildModel.ts), and a stored or selected value is validated
 * against the chosen model's own list — so this type is deliberately the widest thing any might carry.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The reasoning effort stored for a provider that has no effort dial. Never sent to the provider —
 * the field is not nullable, so it holds one uniform value instead of whatever the last dial-having
 * provider was left on.
 */
export const NO_DIAL_EFFORT: ReasoningEffort = "low";

/**
 * How "thinking off" is stored: a model with its Thinking switch off runs at effort "none".
 *
 * This is why a model whose thinking can be switched off must list "none" among its efforts —
 * there would otherwise be no storable representation of the off state.
 */
export const THINKING_OFF_EFFORT: ReasoningEffort = "none";
