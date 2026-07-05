// Factory that instantiates the LangChain chat model from provider config.
// Supports OpenAI (responses API + reasoning), Anthropic (extended thinking), and DeepSeek.

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { LLMProviderConfig, ReasoningEffort } from "./interfaces";

export type { ReasoningEffort };

// Legacy extended-thinking budgets, keyed by the workspace's reasoning-effort knob. Used only for
// models that still accept thinking:{type:"enabled", budget_tokens} — see ANTHROPIC_ADAPTIVE_MODELS.
const ANTHROPIC_THINKING_BUDGET: Partial<Record<ReasoningEffort, number>> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 32_000,
  max: 48_000,
};

// Anthropic models that require the adaptive-thinking API (thinking:{type:"adaptive"} +
// output_config.effort) and REJECT the legacy thinking:{type:"enabled", budget_tokens} shape with a
// 400 ("thinking.type.enabled is not supported for this model"). Keep in sync with the `anthropic`
// list in lib/workspace/models.ts: a model listed there but absent here falls through to the legacy
// budget_tokens path (correct for older models like claude-haiku-4-5, which in turn rejects effort).
const ANTHROPIC_ADAPTIVE_MODELS = new Set<string>(["claude-opus-4-8", "claude-sonnet-5"]);

// The thinking/effort request fields for an Anthropic model. Newer models (Opus 4.7+, Sonnet 5, Fable
// 5) take adaptive thinking with output_config.effort; the reasoning-effort knob maps straight onto
// effort. Older models take the legacy fixed thinking budget and do not accept effort.
export function anthropicThinkingConfig(model: string, effort: ReasoningEffort) {
  if (ANTHROPIC_ADAPTIVE_MODELS.has(model)) {
    // Anthropic effort accepts low…max; the none/minimal members of ReasoningEffort never reach here
    // because they aren't in anthropic's PROVIDER_METADATA list (so validation rejects them upstream).
    return { thinking: { type: "adaptive" as const }, outputConfig: { effort: effort as Exclude<ReasoningEffort, "none" | "minimal"> } };
  }
  return { thinking: { type: "enabled" as const, budget_tokens: ANTHROPIC_THINKING_BUDGET[effort] ?? 10_000 } };
}

type ModelBuilder = (config: LLMProviderConfig) => ChatOpenAI | ChatAnthropic;

const MODEL_BUILDERS: Record<string, ModelBuilder> = {
  anthropic: (config) => {
    if (!config.anthropicModel) throw new Error("no anthropic model selected for this workspace");
    return new ChatAnthropic({
      model: config.anthropicModel,
      apiKey: config.anthropicApiKey,
      ...anthropicThinkingConfig(config.anthropicModel, config.reasoningEffort),
      ...(config.anthropicCacheTtl1h && {
        clientOptions: {
          defaultHeaders: { "anthropic-beta": "prompt-caching-scope-2026-01-05" },
        },
      }),
    });
  },
  deepseek: (config) => {
    if (!config.deepseekModel) throw new Error("no deepseek model selected for this workspace");
    return new ChatOpenAI({
      model: config.deepseekModel,
      configuration: {
        baseURL: "https://api.deepseek.com/v1",
        apiKey: config.deepseekApiKey,
      },
    });
  },
  openai: (config) => {
    if (!config.openaiModel) throw new Error("no openai model selected for this workspace");
    // OpenAI accepts none|minimal|low|medium|high|xhigh (never "max" — validation keeps it out).
    // "none" disables reasoning, so we omit the summary request (nothing would be produced to
    // summarize); every other level pairs with an auto summary.
    const effort = config.reasoningEffort as Exclude<ReasoningEffort, "max">;
    return new ChatOpenAI({
      model: config.openaiModel,
      openAIApiKey: config.openaiApiKey,
      useResponsesApi: true,
      reasoning: effort === "none" ? { effort } : { effort, summary: "auto" },
    });
  },
};

export function buildModel(config: LLMProviderConfig): ChatOpenAI | ChatAnthropic {
  return (MODEL_BUILDERS[config.provider] ?? MODEL_BUILDERS.openai)(config);
}

// The providers the app supports — the source of truth for the UI provider picker and the API-side
// validation of a workspace's stored provider. Derived from the builder map so it can't drift.
export const SUPPORTED_PROVIDERS = Object.keys(MODEL_BUILDERS);

// The concrete model id a config resolves to (the selected provider's model field). Used to attribute
// per-turn usage to a model for cost tracking. Undefined only if the selected provider's model is unset.
export function selectedModelId(config: LLMProviderConfig): string | undefined {
  switch (config.provider) {
    case "anthropic": return config.anthropicModel;
    case "deepseek":  return config.deepseekModel;
    default:          return config.openaiModel;
  }
}

interface ProviderMetadata {
  supportsPromptCaching: boolean;
  // The reasoning-effort levels this provider actually accepts (a subset of ReasoningEffort), quietest
  // first — sourced from the installed SDK unions: OpenAI takes none…xhigh, Anthropic low…max. Drives
  // BOTH the picker's options and the API-side validation, so the UI can't offer a level the provider
  // would reject. Empty when the provider has no effort dial (DeepSeek gates reasoning by model name,
  // not a knob), which is also how the UI knows to hide the control.
  reasoningEfforts: ReasoningEffort[];
}

const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  anthropic: { supportsPromptCaching: true, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  openai:    { supportsPromptCaching: false, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"] },
  deepseek:  { supportsPromptCaching: false, reasoningEfforts: [] },
};

export function getProviderMetadata(provider: string): ProviderMetadata {
  return PROVIDER_METADATA[provider] ?? PROVIDER_METADATA.openai;
}
