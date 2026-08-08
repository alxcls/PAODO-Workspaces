// The model-selection vocabulary exposed to every trigger. Provider ids are keys so callers can
// resolve one selection without scanning parallel arrays; each entry keeps its models and effort
// levels together. Only providers with an API key configured are usable and therefore published.
import { configuredProviders, getProviderMetadata } from "@/lib/agent/buildModel";
import type { ReasoningEffort } from "@/lib/models/llmSelection";
import { listModels } from "@/lib/models/registry";

export interface ProviderModelCatalog {
  models: string[];
  reasoningEfforts: ReasoningEffort[];
}

export type ModelCatalog = Record<string, ProviderModelCatalog>;

export function getModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  return Object.fromEntries(
    configuredProviders(env).map((provider) => [
      provider,
      {
        models: listModels(provider),
        reasoningEfforts: [...getProviderMetadata(provider).reasoningEfforts],
      },
    ]),
  );
}
