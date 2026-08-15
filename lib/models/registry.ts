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
// Keys are provider ids and must match SUPPORTED_PROVIDERS (lib/agent/buildModel.ts).
export const AVAILABLE_MODELS: Record<string, readonly string[]> = {
  anthropic: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"],
  // 5.1 and 5 are priced identically ($1.25/$10 per M); the newer of the two leads.
  openai: ["gpt-5.1", "gpt-5", "gpt-5.4", "gpt-5.5", "gpt-5.5-pro"],
  // DeepSeek's Aug 16 2026 move to peak/off-peak pricing put Pro between $0.66 and $3.96 per M
  // output depending on the hour; Flash is flat and cheaper at every hour, so it leads.
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  moonshot: ["kimi-k3"],
  // The two generalist models retained for the ReAct loop. These are the API's own current aliases,
  // confirmed by GET /v1/models. Medium supports optional reasoning; Large does not expose it. The
  // smaller/specialist Mistral models are deliberately not offered.
  mistral: ["mistral-large-latest", "mistral-medium-latest"],
};

/** The models offered for a provider (empty for an unknown provider). Drives the model picker dropdown. */
export function listModels(provider: string): string[] {
  return [...(AVAILABLE_MODELS[provider] ?? [])];
}

/** Every offered model id, across every provider — what the pricing refresh checks for coverage. */
export function offeredModelIds(): string[] {
  return Object.values(AVAILABLE_MODELS).flat();
}
