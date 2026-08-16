// The model-selection vocabulary exposed to every trigger. Provider ids are keys so callers can
// resolve one selection without scanning parallel arrays; each entry keeps its models and effort
// levels together.
//
// Every provider .env has not switched off is published, WHETHER OR NOT IT HAS AN API KEY. This used
// to publish only keyed providers, which made a deployment with no keys serve an empty catalog and an
// empty picker — no way in from a fresh install, since keys are now entered in the app. What a key
// changes is `hasKey`, so a caller can see that a provider is offered but cannot currently run.
import { availableProviders, getProviderMetadata } from "@/lib/agent/buildModel";
import type { ReasoningEffort } from "@/lib/models/llmSelection";
import { listModels } from "@/lib/models/registry";
import { providerHasKey } from "@/lib/operations/settings/providerKeys";

export interface ProviderModelCatalog {
  models: string[];
  reasoningEfforts: ReasoningEffort[];
  /**
   * Whether an API key is stored for this provider — that is, whether choosing it yields a workspace
   * that can actually run.
   *
   * A BOOLEAN AND NOTHING MORE, on purpose. This catalog is readable by the instance CLI token, which
   * is allowed to know that a provider is unusable but not to learn anything about the key itself.
   * The masked hint and the set-date live on GET /api/settings/provider-keys, which the CLI cannot
   * reach at all. Widening this field re-opens that decision by accident.
   */
  hasKey: boolean;
}

export type ModelCatalog = Record<string, ProviderModelCatalog>;

/**
 * `hasKey` is injected rather than imported directly so tests can describe a deployment's key state
 * as data, instead of writing an encrypted store to disk to assert on a catalog shape.
 */
export function getModelCatalog(
  env: Record<string, string | undefined> = process.env,
  hasKey: (provider: string) => boolean = providerHasKey,
): ModelCatalog {
  return Object.fromEntries(
    availableProviders(env).map((provider) => [
      provider,
      {
        models: listModels(provider),
        reasoningEfforts: [...getProviderMetadata(provider).reasoningEfforts],
        hasKey: hasKey(provider),
      },
    ]),
  );
}
