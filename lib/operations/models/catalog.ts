// The model-selection vocabulary exposed to every trigger. Provider ids are keys so callers can
// resolve one selection without scanning parallel arrays; each entry keeps its models and effort
// levels together. Only providers that are usable are published: an API key must be configured and
// .env must not have switched the provider off (`<PROVIDER>_AVAILABLE=false`).
import { availableProviders, getProviderMetadata } from "@/lib/agent/buildModel";
import { type ReasoningEffort, type ThinkingSupport } from "@/lib/models/llmSelection";
import { AVAILABLE_MODELS, listModels } from "@/lib/models/registry";

// Re-exported, not defined here. The agent runtime needs the same answer on every run, and having it
// import this trigger-facing module for a provider fact pointed the dependency the wrong way — so it
// lives in the provider registry now (lib/agent/buildModel.ts), with the rule itself in
// lib/models/selection.ts. Operations-layer callers keep importing it from here.
export { defaultModelSelection } from "@/lib/agent/buildModel";

export interface ProviderModelCatalog {
  models: string[];
  reasoningEfforts: ReasoningEffort[];
  /**
   * Per-model thinking capability, keyed by model id — the picker reads it to decide whether to draw
   * the thinking checkbox for the selected model, and whether that box is interactive or checked and
   * disabled. Per model rather than per provider because Mistral serves all three kinds at once;
   * see ThinkingSupport. Every id in `models` has an entry, so the UI never has to guess a default.
   */
  thinking: Record<string, ThinkingSupport>;
}

export type ModelCatalog = Record<string, ProviderModelCatalog>;

export function getModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  return Object.fromEntries(
    availableProviders(env).map((provider) => [
      provider,
      {
        models: listModels(provider),
        reasoningEfforts: [...getProviderMetadata(provider).reasoningEfforts],
        thinking: Object.fromEntries((AVAILABLE_MODELS[provider] ?? []).map((entry) => [entry.id, entry.thinking])),
      },
    ]),
  );
}
