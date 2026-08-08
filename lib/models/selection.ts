// How a partial model choice becomes a complete one. Owned here, in one place, because both surfaces
// need the same answer: the picker resolves it client-side so the dropdowns fill in without a
// round-trip, and the update path resolves it server-side so a programmatic caller (CLI, script,
// agent) gets the picker's behavior without reimplementing it.
//
// Kept free of the provider registry on purpose. The accepted models and effort levels live in
// server-only modules (lib/agent/buildModel.ts pulls the LLM SDKs), so instead of importing them this
// module takes the selected provider's vocabulary as data — the server reads it from the registry, the
// client from GET /api/models, which serves that same registry. Nothing here imports at runtime beyond
// DEFAULT_LLM, itself a plain const in a type-only module.
import { DEFAULT_LLM, type ReasoningEffort } from "@/lib/models/llmSelection";

/** What the selected provider accepts. Empty `reasoningEfforts` means the provider has no effort dial. */
export interface ModelVocabulary {
  models: readonly string[];
  reasoningEfforts: readonly ReasoningEffort[];
}

/** A complete, usable choice — what the workspace stores and the agent runs with. */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

/** A choice as a caller expressed it: any subset, each field independently omittable. */
export interface RequestedModelSelection {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

/**
 * The model to select when the caller named none and the previous one no longer applies: the
 * provider's first catalog entry, which the catalog orders flagship-first. Empty when the provider
 * serves no models, which the caller reports rather than storing.
 */
export function defaultModelFor(vocabulary: ModelVocabulary): string {
  return vocabulary.models[0] ?? "";
}

/**
 * The effort to start a provider at. Deliberately not the level the previous provider was on: the
 * vocabularies only partly overlap, so carrying a level across would sometimes produce a selection the
 * new provider rejects at call time — a failure far from the change that caused it. A known-good level
 * every time is worth more than preserving a choice the caller can always restate.
 *
 * "low" whenever offered, which is every provider that has a dial today. The fallback is the quietest
 * level the provider does offer rather than its first: `none` disables reasoning outright on OpenAI, so
 * position alone is not a safe rule.
 */
export function defaultEffortFor(vocabulary: ModelVocabulary): ReasoningEffort {
  const accepted = vocabulary.reasoningEfforts;
  if (accepted.includes("low")) return "low";
  return accepted.find((effort) => effort !== "none") ?? accepted[0];
}

/**
 * Completes a partial model choice against the current selection and the chosen provider's vocabulary.
 *
 * Resolution is per field, so any subset works. An omitted provider keeps the current one. An omitted
 * model and an omitted effort both keep their current value while the provider is unchanged, except a
 * model change resets effort to that provider's default. An explicit effort always wins. A provider
 * with no effort dial always resolves to the stored placeholder.
 *
 * Validation is NOT done here: this decides what was meant, not whether it is allowed. The caller
 * checks the provider against its registry and the effort against `vocabulary` — it owns the error
 * messages, and only it knows whether an unacceptable value should be refused or coerced. An effort
 * supplied to a no-dial provider is one of those refusals, and validateMetadata raises on it; this
 * function only reports the placeholder it resolved to.
 */
export function resolveModelSelection(
  requested: RequestedModelSelection,
  current: ModelSelection,
  vocabularyFor: (provider: string) => ModelVocabulary,
): ModelSelection {
  const provider = trimmed(requested.provider) ?? current.provider;
  const vocabulary = vocabularyFor(provider);
  const providerChanged = provider !== current.provider;

  // A provider switch retires the previous model and effort alike. On the same provider, a model
  // change keeps that explicit model but resets effort below; an effort-only change keeps the model.
  const model = trimmed(requested.model) ?? (providerChanged ? defaultModelFor(vocabulary) : current.model);
  const modelChanged = model !== current.model;

  if (vocabulary.reasoningEfforts.length === 0) {
    // The stored value is a placeholder the agent never sends. Overwriting it with the default keeps
    // every no-dial provider reading the same rather than preserving whatever the last one used.
    return { provider, model, reasoningEffort: DEFAULT_LLM.reasoningEffort };
  }

  const reasoningEffort =
    (trimmed(requested.reasoningEffort) as ReasoningEffort | undefined) ??
    (providerChanged || modelChanged ? defaultEffortFor(vocabulary) : current.reasoningEffort);

  return { provider, model, reasoningEffort };
}
