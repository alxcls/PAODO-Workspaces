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
// the workspace record (not in .env). When a workspace has made no choice, the agent falls back to
// DEFAULT_LLM. .env carries only the provider API keys.
export interface WorkspaceLlmSelection {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export const DEFAULT_LLM: WorkspaceLlmSelection = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  reasoningEffort: "low",
};
