// Curated, hand-maintained catalog of the models offered in the per-workspace model picker.
//
// Model NAMES are owned HERE — this app decides which models to expose, not an upstream feed. To
// add or retire a model, edit the lists below. Pricing is a separate concern: cost math resolves
// per-token rates from the vendored price list (lib/models/pricing.ts), refreshed with
// `npm run update-pricing`. A model listed here should have a matching pricing entry so its usage
// cost resolves; if it doesn't, cost simply renders as unknown (never a fake $0). That script now
// FAILS if a model added here prices in neither of its sources, so the gap surfaces at refresh time.
//
// Each list runs cheapest to priciest, so the first entry — what the picker highlights and what
// defaultModelFor resolves a bare provider choice to — is the provider's least expensive model.
//
// Each entry also declares whether the model THINKS (see ThinkingSupport). That is per model, not
// per provider, because Mistral serves all three kinds under one provider id — a model that takes a
// thinking switch, a model that always thinks and rejects the switch, and a model with no thinking
// mode at all. The picker renders the checkbox from this field and buildModel decides from it
// whether to send a reasoning parameter, so the two can never disagree.
//
// Keys are provider ids and must match SUPPORTED_PROVIDERS (lib/agent/buildModel.ts).
import type { ThinkingSupport } from "./llmSelection";

export interface ModelEntry {
  /** The id sent to the provider's API verbatim, and the key usage cost is priced by. */
  id: string;
  thinking: ThinkingSupport;
}

export const AVAILABLE_MODELS: Record<string, readonly ModelEntry[]> = {
  // Anthropic models are `always` because buildModel sends a thinking config on every request —
  // adaptive for the newer pair, a legacy token budget for haiku. See anthropicThinkingConfig.
  anthropic: [
    { id: "claude-haiku-4-5", thinking: "always" },
    { id: "claude-sonnet-5", thinking: "always" },
    { id: "claude-opus-4-8", thinking: "always" },
  ],
  // OpenAI's effort dial includes "none", which disables reasoning outright — so these genuinely
  // toggle, and the checkbox drives that level rather than a separate request field.
  // 5.1 and 5 are priced identically ($1.25/$10 per M); the newer of the two leads.
  openai: [
    { id: "gpt-5.1", thinking: "toggle" },
    { id: "gpt-5", thinking: "toggle" },
    { id: "gpt-5.4", thinking: "toggle" },
    { id: "gpt-5.5", thinking: "toggle" },
    { id: "gpt-5.5-pro", thinking: "toggle" },
  ],
  // DeepSeek's Aug 16 2026 move to peak/off-peak pricing put Pro between $0.66 and $3.96 per M
  // output depending on the hour; Flash is flat and cheaper at every hour, so it leads.
  // DeepSeek gates reasoning by model name rather than a request field, so neither model toggles.
  deepseek: [
    { id: "deepseek-v4-flash", thinking: "never" },
    { id: "deepseek-v4-pro", thinking: "never" },
  ],
  // Kimi K3 always thinks — which is why moonshot's effort list offers no none/minimal.
  moonshot: [{ id: "kimi-k3", thinking: "always" }],
  // Mistral is the provider that forced thinking to be per-model.
  //
  // The magistral pair is `always`: those models reason natively and answer 400 if reasoning_effort
  // is sent at all, so buildModel must omit the field for them rather than send "high".
  // They are the only `-latest` aliases in this file — Mistral publishes several same-priced dated
  // magistral ids (2506, 2509, 1-2-2509) without documenting which is current, and a wrong pin is
  // worse than an alias that always resolves.
  mistral: [
    { id: "ministral-3-3b-2512", thinking: "never" },
    { id: "ministral-3-8b-2512", thinking: "never" },
    { id: "labs-devstral-small-2512", thinking: "never" },
    { id: "ministral-3-14b-2512", thinking: "never" },
    { id: "mistral-small-2603", thinking: "toggle" },
    { id: "codestral-2508", thinking: "never" },
    { id: "mistral-large-2512", thinking: "never" },
    { id: "magistral-small-latest", thinking: "always" },
    { id: "devstral-2512", thinking: "never" },
    { id: "magistral-medium-latest", thinking: "always" },
    { id: "mistral-medium-2604", thinking: "toggle" },
  ],
};

/** The models offered for a provider (empty for an unknown provider). Drives the model picker dropdown. */
export function listModels(provider: string): string[] {
  return (AVAILABLE_MODELS[provider] ?? []).map((entry) => entry.id);
}

/** Every offered model id, across every provider — what the pricing refresh checks for coverage. */
export function offeredModelIds(): string[] {
  return Object.values(AVAILABLE_MODELS).flatMap((entries) => entries.map((entry) => entry.id));
}

/**
 * Whether a model thinks, and whether that can be switched off.
 *
 * Unknown models answer "never" rather than guessing: a workspace's llmModel is free-form (the PATCH
 * route accepts an id this catalog doesn't list yet), and inventing a thinking capability for one
 * would send a reasoning field the provider may reject. Silence is the safe default.
 */
export function thinkingSupport(provider: string, model: string): ThinkingSupport {
  return AVAILABLE_MODELS[provider]?.find((entry) => entry.id === model)?.thinking ?? "never";
}
