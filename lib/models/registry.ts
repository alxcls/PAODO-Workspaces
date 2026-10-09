/**
 * Curated, hand-maintained catalog of the models offered in the per-workspace model picker.
 *
 * Model NAMES are owned here; to add or retire one, edit the lists below. Rates are separate: they
 * come from the vendored price list (./pricing.ts), and `npm run update-pricing` FAILS if a model
 * listed here prices in neither of its sources. An unpriced model's cost renders as unknown.
 *
 * Each list runs cheapest to priciest: the first entry is what the picker highlights and what
 * defaultModelFor resolves a bare provider choice to. Within a tier the newer model leads.
 *
 * Keys are provider ids and must match SUPPORTED_PROVIDERS (lib/agent/buildModel.ts).
 */
export const AVAILABLE_MODELS: Record<string, readonly string[]> = {
  anthropic: [
    "claude-haiku-5-5",
    "claude-haiku-4-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-opus-5-5",
    "claude-opus-4-8",
  ],
  // 5.1 and 5 are priced identically ($1.25/$10 per M); the newer of the two leads.
  openai: ["gpt-5.1", "gpt-5", "gpt-5.4", "gpt-5.5", "gpt-5.5-pro"],
  // `deepseek-flash` is V4.1 Flash (the old `deepseek-v4-flash` id now just aliases it); Pro stays a
  // distinct, pricier model until DeepSeek reroutes it to V4.1 Flash on 14 Sep 2026. Flash leads.
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  moonshot: ["kimi-k3"],
  // Pinned by id: `mistral-large-latest` still resolves to Large 3, whose quota is 15 requests/min.
  mistral: ["mistral-large-4"],
  // Serverless ids — the bare names; the `qwen/…:fp8` forms are Dedicated Deployment only. Flash
  // leads: it alone prices cached input, at a fifth of its own rate, which is most of a loop's input.
  scaleway: ["deepseek-v4-flash-0731", "qwen3.6-35b-a3b"],
};

/** The models offered for a provider (empty for an unknown provider). Drives the model picker dropdown. */
export function listModels(provider: string): string[] {
  return [...(AVAILABLE_MODELS[provider] ?? [])];
}

/** Every offered model id, across every provider — what the pricing refresh checks for coverage. */
export function offeredModelIds(): string[] {
  return Object.values(AVAILABLE_MODELS).flat();
}
