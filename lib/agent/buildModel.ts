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
    return {
      thinking: { type: "adaptive" as const },
      outputConfig: { effort: effort as Exclude<ReasoningEffort, "none" | "minimal"> },
    };
  }
  return { thinking: { type: "enabled" as const, budget_tokens: ANTHROPIC_THINKING_BUDGET[effort] ?? 10_000 } };
}

// The capability half of a provider entry — the only part callers outside this module see.
interface ProviderMetadata {
  supportsPromptCaching: boolean;
  // The reasoning-effort levels this provider actually accepts (a subset of ReasoningEffort), quietest
  // first — sourced from the installed SDK unions: OpenAI takes none…xhigh, Anthropic low…max. Drives
  // BOTH the picker's options and the API-side validation, so the UI can't offer a level the provider
  // would reject. Empty when the provider has no effort dial (DeepSeek gates reasoning by model name,
  // not a knob), which is also how the UI knows to hide the control.
  reasoningEfforts: ReasoningEffort[];
}

interface ProviderDescriptor extends ProviderMetadata {
  /** The .env var carrying this provider's API key — resolved into config.apiKey by loadAgentConfig. */
  apiKeyEnv: string;
  build: (config: LLMProviderConfig) => ChatOpenAI | ChatAnthropic;
}

// The single source of truth for provider support: capabilities, key env var and model construction
// in one entry. Adding a provider means adding one entry here plus its models in
// lib/workspace/models.ts — nothing else in the agent layer changes.
const PROVIDERS: Record<string, ProviderDescriptor> = {
  anthropic: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsPromptCaching: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    build: (config) =>
      new ChatAnthropic({
        model: config.model,
        apiKey: config.apiKey,
        ...anthropicThinkingConfig(config.model, config.reasoningEffort),
        ...(config.anthropicCacheTtl1h && {
          clientOptions: {
            defaultHeaders: { "anthropic-beta": "prompt-caching-scope-2026-01-05" },
          },
        }),
      }),
  },
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    supportsPromptCaching: false,
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    build: (config) => {
      // OpenAI accepts none|minimal|low|medium|high|xhigh (never "max" — validation keeps it out).
      // "none" disables reasoning, so we omit the summary request (nothing would be produced to
      // summarize); every other level pairs with an auto summary.
      const effort = config.reasoningEffort as Exclude<ReasoningEffort, "max">;
      return new ChatOpenAI({
        model: config.model,
        // `apiKey`, not the legacy `openAIApiKey` alias — the latter is silently ignored by
        // @langchain/openai v1, which then falls back to process.env.OPENAI_API_KEY on its own.
        apiKey: config.apiKey,
        useResponsesApi: true,
        reasoning: effort === "none" ? { effort } : { effort, summary: "auto" },
      });
    },
  },
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    supportsPromptCaching: false,
    reasoningEfforts: [],
    build: (config) =>
      new ChatOpenAI({
        model: config.model,
        configuration: {
          baseURL: "https://api.deepseek.com/v1",
          apiKey: config.apiKey,
        },
      }),
  },
  moonshot: {
    apiKeyEnv: "MOONSHOT_API_KEY",
    supportsPromptCaching: false,
    // Kimi K3 takes low|high|max only — no medium, and none/minimal aren't offered because K3 always
    // thinks. The narrower list is why the effort knob is validated per provider rather than globally.
    reasoningEfforts: ["low", "high", "max"],
    build: (config) =>
      new ChatOpenAI({
        model: config.model,
        configuration: {
          baseURL: "https://api.moonshot.ai/v1",
          apiKey: config.apiKey,
        },
        // Sent via modelKwargs, not the `reasoningEffort` field: that field is typed to OpenAI's
        // effort union, which has no "max" — Kimi's default and strongest level. modelKwargs is
        // spread verbatim into the chat-completions body, so the value reaches the API untranslated.
        modelKwargs: { reasoning_effort: config.reasoningEffort },
      }),
  },
};

export function buildModel(config: LLMProviderConfig): ChatOpenAI | ChatAnthropic {
  const descriptor = PROVIDERS[config.provider];
  // Unknown providers fail loudly here rather than silently resolving to another vendor's builder:
  // the API validates provider on write, so reaching this means a retired provider is still stored.
  if (!descriptor) {
    throw new Error(`unsupported LLM provider "${config.provider}" (supported: ${SUPPORTED_PROVIDERS.join(", ")})`);
  }
  if (!config.model) throw new Error(`no model selected for provider "${config.provider}"`);
  return descriptor.build(config);
}

// The providers the app supports — the source of truth for the UI provider picker and the API-side
// validation of a workspace's stored provider. Derived from the registry so it can't drift.
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

// The supported providers that actually have an API key configured. Drives the UI provider picker, so
// a provider whose key isn't in .env is never offered. This is a usability filter, not enforcement:
// the PATCH route still validates against SUPPORTED_PROVIDERS, and a selection stored before a key was
// removed keeps working here only insofar as the provider stays listed.
export function configuredProviders(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(PROVIDERS)
    .filter(([, { apiKeyEnv }]) => Boolean(env[apiKeyEnv]?.trim()))
    .map(([provider]) => provider);
}

/** Whether startup has credentials for at least one supported LLM provider. */
export function hasConfiguredProviderApiKey(env: Record<string, string | undefined> = process.env): boolean {
  return configuredProviders(env).length > 0;
}

// The env var holding a provider's API key; undefined for an unknown provider (buildModel rejects it).
export function providerApiKeyEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.apiKeyEnv;
}

// Total by design: callers include GET /api/models, which passes an unvalidated query param.
export function getProviderMetadata(provider: string): ProviderMetadata {
  return PROVIDERS[provider] ?? PROVIDERS.openai;
}
