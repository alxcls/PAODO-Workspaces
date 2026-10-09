/**
 * Curated, hand-maintained catalog of the models offered in the per-workspace model picker: one
 * record per model, holding its id, the effort levels it accepts and any fact only its vendor needs.
 *
 * To add or retire a model, edit its provider's list below — nothing else names a model. Rates are
 * separate: they come from the vendored price list (./pricing.ts), and `npm run update-pricing`
 * FAILS if a model listed here prices in neither of its sources.
 *
 * Each list runs cheapest to priciest: the first entry is what the picker highlights and what
 * defaultModelFor resolves a bare provider choice to. Within a tier the newer model leads.
 */
import type { ReasoningEffort } from "./llmSelection";

export interface ModelSpec {
  id: string;
  /**
   * The reasoning-effort levels the model accepts, quietest first. Drives the picker and API-side
   * validation alike. "none" means thinking can be switched off; an empty list means no dial.
   */
  efforts: readonly ReasoningEffort[];
}

export interface AnthropicModelSpec extends ModelSpec {
  /** How thinking is requested: adaptive with an effort, or the legacy token budget, which rejects effort. */
  thinking: "adaptive" | "budget";
  /** The `thinking.type` that runs the model without thinking. Absent when it always thinks. */
  thinkingOff?: "disabled" | "between_tools";
}

export interface ScalewayModelSpec extends ModelSpec {
  /** `default_reasoning_value`: what the model reasons at when sent a level it does not support. */
  fallbackEffort: ReasoningEffort;
}

const LOW_TO_MAX: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const NONE_TO_MAX: readonly ReasoningEffort[] = ["none", ...LOW_TO_MAX];
const NONE_TO_XHIGH: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];

// Transcribed from the thinking table in Anthropic's API docs.
const ANTHROPIC_MODELS: readonly AnthropicModelSpec[] = [
  { id: "claude-haiku-5-5", efforts: NONE_TO_MAX, thinking: "adaptive", thinkingOff: "disabled" },
  { id: "claude-haiku-4-5", efforts: NONE_TO_MAX, thinking: "budget", thinkingOff: "disabled" },
  // Rejects "disabled": "between_tools" is how it is told to run without thinking.
  { id: "claude-sonnet-5-5", efforts: NONE_TO_MAX, thinking: "adaptive", thinkingOff: "between_tools" },
  { id: "claude-sonnet-5", efforts: NONE_TO_MAX, thinking: "adaptive", thinkingOff: "disabled" },
  // Always thinks: the API rejects every way of switching it off, at every effort level.
  { id: "claude-opus-5-5", efforts: LOW_TO_MAX, thinking: "adaptive" },
  { id: "claude-opus-4-8", efforts: NONE_TO_MAX, thinking: "adaptive", thinkingOff: "disabled" },
];

// Levels transcribed from each model's page. 5.1 leads as the default; the rest are ordered by
// input rate, then output. 6.1 Sol and 6 Sol are priced as a pair, and the newer comes first.
const OPENAI_MODELS: readonly ModelSpec[] = [
  { id: "gpt-5.1", efforts: ["none", "low", "medium", "high"] },
  { id: "gpt-6-luna", efforts: NONE_TO_MAX },
  { id: "gpt-5.6-luna", efforts: NONE_TO_MAX },
  // The only model that takes "minimal", and it cannot switch reasoning off.
  { id: "gpt-5", efforts: ["minimal", "low", "medium", "high"] },
  // Always reasons: OpenAI's guidance for a caller that used to send "none" is "low".
  { id: "gpt-6.1-sol", efforts: LOW_TO_MAX },
  { id: "gpt-6-sol", efforts: NONE_TO_MAX },
  { id: "gpt-5.6-terra", efforts: NONE_TO_MAX },
  { id: "gpt-5.4", efforts: NONE_TO_XHIGH },
  { id: "gpt-5.6-sol", efforts: NONE_TO_MAX },
  { id: "gpt-5.5", efforts: NONE_TO_XHIGH },
  // Always reasons, like 6.1 Sol.
  { id: "gpt-6-astra", efforts: LOW_TO_MAX },
  { id: "gpt-5.5-pro", efforts: ["medium", "high", "xhigh"] },
];

// V4 thinks by default at "high" since 13 Aug 2026, so the dial is what keeps a run from paying for
// reasoning nobody asked for. "none" is offered because only it switches thinking off.
const DEEPSEEK_V4_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "high", "max"];

// `deepseek-flash` is V4.1 Flash (the old `deepseek-v4-flash` id now just aliases it); Pro stays a
// distinct, pricier model until DeepSeek reroutes it to V4.1 Flash on 14 Sep 2026. Flash leads.
const DEEPSEEK_MODELS: readonly ModelSpec[] = [
  { id: "deepseek-flash", efforts: DEEPSEEK_V4_EFFORTS },
  { id: "deepseek-v4-pro", efforts: DEEPSEEK_V4_EFFORTS },
];

const MOONSHOT_MODELS: readonly ModelSpec[] = [
  // No medium, and no none or minimal: Kimi K3 always thinks.
  { id: "kimi-k3", efforts: ["low", "high", "max"] },
];

const MISTRAL_MODELS: readonly ModelSpec[] = [
  // Pinned by id: `mistral-large-latest` still resolves to Large 3, whose quota is 15 requests/min.
  // A plain on/off switch: "none" disables reasoning, "high" enables it.
  { id: "mistral-large-4", efforts: ["none", "high"] },
];

/**
 * Serverless ids — the bare names; the `qwen/…:fp8` forms are Dedicated Deployment only. Flash
 * leads: it alone prices cached input, at a fifth of its own rate, which is most of a loop's input.
 *
 * Levels are transcribed from Scaleway's product catalog and CHECKED IN RATHER THAN FETCHED: they
 * decide what the picker offers, so a vendor outage must not narrow a stored choice. Instead
 * `npm run update-pricing` re-reads the same rows and FAILS on any drift from these records.
 *
 * The gateway does not enforce them. It accepts every level on every model and quietly collapses
 * an unsupported one to the model's default, so these records are the only place it is written down.
 */
const SCALEWAY_MODELS: readonly ScalewayModelSpec[] = [
  { id: "deepseek-v4-flash-0731", efforts: ["none", "low", "high", "max"], fallbackEffort: "high" },
  // Genuinely binary: "medium" is its only thinking level, so the picker shows a switch, not a dial.
  { id: "qwen3.6-35b-a3b", efforts: ["none", "medium"], fallbackEffort: "medium" },
];

/** Every offered model, by provider. Keys must match SUPPORTED_PROVIDERS (lib/agent/buildModel.ts). */
export const MODEL_CATALOG: Readonly<Record<string, readonly ModelSpec[]>> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
  moonshot: MOONSHOT_MODELS,
  mistral: MISTRAL_MODELS,
  scaleway: SCALEWAY_MODELS,
};

/** The offered model ids by provider, in catalog order. */
export const AVAILABLE_MODELS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(MODEL_CATALOG).map(([provider, models]) => [provider, models.map((model) => model.id)]),
);

/** The models offered for a provider (empty for an unknown provider). Drives the model picker dropdown. */
export function listModels(provider: string): string[] {
  return [...(AVAILABLE_MODELS[provider] ?? [])];
}

/** Every offered model id, across every provider — what the pricing refresh checks for coverage. */
export function offeredModelIds(): string[] {
  return Object.values(AVAILABLE_MODELS).flat();
}

/** Each of a provider's models beside its effort levels — what the vocabulary and the catalog API carry. */
export function modelEffortLists(provider: string): Record<string, readonly ReasoningEffort[]> {
  return Object.fromEntries((MODEL_CATALOG[provider] ?? []).map((model) => [model.id, model.efforts]));
}

/** An offered Anthropic model's record; undefined for any other id. */
export function anthropicModel(id: string): AnthropicModelSpec | undefined {
  return ANTHROPIC_MODELS.find((model) => model.id === id);
}

/** An offered Scaleway model's record; undefined for any other id. */
export function scalewayModel(id: string): ScalewayModelSpec | undefined {
  return SCALEWAY_MODELS.find((model) => model.id === id);
}
