// Curated, hand-maintained catalog of the models offered in the per-workspace model picker.
//
// Model NAMES are owned HERE — this app decides which models to expose, not an upstream feed. To
// add or retire a model, edit the lists below. Pricing is a separate concern: cost math resolves
// per-token rates from the vendored price list (lib/models/pricing.ts), refreshed with
// `npm run update-pricing`. A model listed here should have a matching pricing entry so its usage
// cost resolves; if it doesn't, cost simply renders as unknown (never a fake $0). That script now
// FAILS if a model added here prices in neither of its sources, so the gap surfaces at refresh time.
//
// Keys are provider ids and must match SUPPORTED_PROVIDERS (lib/agent/buildModel.ts).
export const AVAILABLE_MODELS: Record<string, readonly string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.1", "gpt-5"],
  // Flash leads on cost, not capability: DeepSeek's Aug 16 2026 move to peak/off-peak pricing put Pro
  // between $0.66 and $3.96 per M output depending on the hour, so it is no longer the sane default.
  // Being first also makes Flash what defaultModelFor picks for a bare "deepseek" choice.
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  moonshot: ["kimi-k3"],
};

// The models offered for a provider (empty for an unknown provider). Drives the model picker dropdown.
export function listModels(provider: string): string[] {
  return [...(AVAILABLE_MODELS[provider] ?? [])];
}
