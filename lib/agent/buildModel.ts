// Factory that instantiates the LangChain chat model from provider config.
// Supports OpenAI (responses API + reasoning), Anthropic (extended thinking), and DeepSeek.

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { LLMProviderConfig, ReasoningEffort } from "./interfaces";

export type { ReasoningEffort };

const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
};

type ModelBuilder = (config: LLMProviderConfig) => ChatOpenAI | ChatAnthropic;

const MODEL_BUILDERS: Record<string, ModelBuilder> = {
  anthropic: (config) => {
    if (!config.anthropicModel) throw new Error("ANTHROPIC_MODEL is not set in .env");
    return new ChatAnthropic({
      model: config.anthropicModel,
      apiKey: config.anthropicApiKey,
      thinking: { type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGET[config.reasoningEffort] },
      ...(config.anthropicCacheTtl1h && {
        clientOptions: {
          defaultHeaders: { "anthropic-beta": "prompt-caching-scope-2026-01-05" },
        },
      }),
    });
  },
  deepseek: (config) => {
    if (!config.deepseekModel) throw new Error("DEEPSEEK_MODEL is not set in .env");
    return new ChatOpenAI({
      model: config.deepseekModel,
      configuration: {
        baseURL: "https://api.deepseek.com/v1",
        apiKey: config.deepseekApiKey,
      },
    });
  },
  openai: (config) => {
    if (!config.openaiModel) throw new Error("OPENAI_MODEL is not set in .env");
    return new ChatOpenAI({
      model: config.openaiModel,
      openAIApiKey: config.openaiApiKey,
      useResponsesApi: true,
      reasoning: { effort: config.reasoningEffort, summary: "auto" },
    });
  },
};

export function buildModel(config: LLMProviderConfig): ChatOpenAI | ChatAnthropic {
  return (MODEL_BUILDERS[config.provider] ?? MODEL_BUILDERS.openai)(config);
}

interface ProviderMetadata {
  supportsPromptCaching: boolean;
}

const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  anthropic: { supportsPromptCaching: true },
  openai:    { supportsPromptCaching: false },
  deepseek:  { supportsPromptCaching: false },
};

export function getProviderMetadata(provider: string): ProviderMetadata {
  return PROVIDER_METADATA[provider] ?? PROVIDER_METADATA.openai;
}
