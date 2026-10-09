/**
 * The model-selection vocabulary exposed to every trigger, keyed by provider id. Each entry keeps
 * its models beside the effort levels each of them accepts.
 *
 * Every provider .env has not switched off is published, WHETHER OR NOT IT HAS AN API KEY: keys are
 * entered in the app, so hiding keyless providers would leave a fresh install an empty picker.
 * `hasKey` is what says whether an offered provider can currently run.
 */
import { availableProviders, vocabularyFor } from "@/lib/agent/buildModel";
import type { ModelVocabulary } from "@/lib/models/selection";
import { providerHasKey } from "@/lib/operations/settings/providerKeys";

export interface ProviderModelCatalog extends ModelVocabulary {
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
    availableProviders(env).map((provider) => [provider, { ...vocabularyFor(provider), hasKey: hasKey(provider) }]),
  );
}
