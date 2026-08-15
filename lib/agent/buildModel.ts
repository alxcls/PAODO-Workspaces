// The provider registry: which LLM providers exist, what each accepts, which .env vars govern it,
// and how to instantiate its LangChain chat model. Supports OpenAI (responses API + reasoning),
// Anthropic (extended thinking), DeepSeek, Moonshot, and Mistral.
//
// Server-only — it imports the LLM SDKs. Anything a client component needs to know about a selection
// lives in lib/models/{llmSelection,selection}.ts, which this module feeds rather than duplicates.

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { LLMProviderConfig } from "./interfaces";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "../models/llmSelection";
import { listModels, thinkingSupport } from "../models/registry";
import { firstAvailableSelection, type ModelSelection, type ModelVocabulary } from "../models/selection";
import { ALPHANUMERIC, narrowestConstraint, type ToolCallIdConstraint } from "./toolCallIdConstraint";

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
// list in lib/models/registry.ts: a model listed there but absent here falls through to the legacy
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

// Mistral's reasoning request field, or nothing at all.
//
// Only the models the registry declares `toggle` (Small 4, Medium 3.5) accept reasoning_effort. The
// magistral pair reasons natively and answers 400 if the field is present at ALL — not merely if it
// disagrees — so an omitted field is the only correct request for them, and the rest of the catalog
// (devstral, codestral, ministral, large) has no thinking mode to address. Reading the registry
// rather than a second list here is what keeps the checkbox the picker renders and the field this
// sends from ever disagreeing.
//
// Sent via modelKwargs rather than the typed `reasoningEffort` field for the same reason as Moonshot:
// that field is typed to OpenAI's effort union, and modelKwargs is spread verbatim into the
// chat-completions body, which is where Mistral reads it from.
export function mistralReasoningConfig(model: string, effort: ReasoningEffort) {
  if (thinkingSupport("mistral", model) !== "toggle") return {};
  // Mistral accepts "none" and "high" and nothing else. Validation already narrows a stored effort to
  // that pair, so this collapses anything else rather than trusting it — a legacy selection carrying
  // another provider's level must not reach the API as an unknown value.
  return { modelKwargs: { reasoning_effort: effort === THINKING_OFF_EFFORT ? "none" : "high" } };
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
  /**
   * The .env var that switches this provider off for the whole deployment. Named per provider rather
   * than derived from the id so both halves of a provider's .env contract are greppable from here.
   */
  availabilityEnv: string;
  /**
   * What this provider requires of an inbound tool-call id, when it requires anything. Omitted means
   * permissive — it accepts whatever the app already stores.
   *
   * Declared here, beside the provider's other facts, rather than hardcoded in the module that mints
   * ids: the app stores ONE id shape for every provider (lib/agent/toolCallIds.ts explains why), so
   * the shape is the intersection of what is declared across this record. A provider whose demand
   * cannot be reconciled with another's fails at module load instead of at request time.
   */
  toolCallIdConstraint?: ToolCallIdConstraint;
  build: (config: LLMProviderConfig) => ChatOpenAI | ChatAnthropic;
}

// The single source of truth for provider support: capabilities, its two env vars (key and
// availability switch) and model construction in one entry. Adding a provider means adding one entry
// here plus its models in lib/models/registry.ts — nothing else in the agent layer changes.
const PROVIDERS: Record<string, ProviderDescriptor> = {
  anthropic: {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    availabilityEnv: "ANTHROPIC_AVAILABLE",
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
    availabilityEnv: "OPENAI_AVAILABLE",
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
    availabilityEnv: "DEEPSEEK_AVAILABLE",
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
    availabilityEnv: "MOONSHOT_AVAILABLE",
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
  mistral: {
    apiKeyEnv: "MISTRAL_API_KEY",
    availabilityEnv: "MISTRAL_AVAILABLE",
    // The only provider that validates inbound tool-call ids: anything other than exactly 9
    // alphanumerics answers 400 ("Tool call IDs should be alphanumeric strings with length 9!").
    // This one declaration is what narrows the app's canonical id shape; the other four accept it
    // because it already sits inside what they take.
    toolCallIdConstraint: { name: "mistral", alphabet: ALPHANUMERIC, minLength: 9, maxLength: 9 },
    // FALSE HERE DOES NOT MEAN UNCACHED. This flag asks "must the prompt builder mark where the
    // cached prefix ends?" — a cache_control block only Anthropic reads. Mistral caches prefixes
    // automatically in 64-token blocks and bills a hit at 10% of the input rate with nothing to
    // annotate, so it gets the discount with this false, exactly as deepseek and moonshot do. (A
    // stable `prompt_cache_key` would raise the hit rate further; it is deliberately not sent,
    // because the key would have to be a workspace id and LLMProviderConfig is kept provider-agnostic.)
    supportsPromptCaching: false,
    // Mistral's dial is binary — "none" or "high", no graded levels — so the picker renders it as the
    // thinking checkbox rather than a dropdown. "none" has to appear here because it is the only
    // storable representation of an unchecked box (see THINKING_OFF_EFFORT).
    reasoningEfforts: [THINKING_OFF_EFFORT, "high"],
    build: (config) =>
      new ChatOpenAI({
        model: config.model,
        configuration: {
          baseURL: "https://api.mistral.ai/v1",
          apiKey: config.apiKey,
        },
        ...mistralReasoningConfig(config.model, config.reasoningEffort),
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

/**
 * The one tool-call id shape every supported provider accepts — the intersection of what they
 * declare above, which lib/agent/toolCallIds.ts generates and enforces against.
 *
 * Resolved at module load ON PURPOSE. If a provider is ever added whose demand cannot be reconciled
 * with an existing one, this throws while the process starts, on the branch that added it, naming
 * both constraints. The failure it replaces is the bad one: a 400 at request time, on a conversation
 * that worked yesterday, about ids the run did not create.
 */
export const TOOL_CALL_ID_CONSTRAINT = narrowestConstraint(
  Object.values(PROVIDERS)
    .map((descriptor) => descriptor.toolCallIdConstraint)
    .filter((constraint): constraint is ToolCallIdConstraint => constraint !== undefined),
);

/**
 * Whether a provider is offered in this deployment, per its `<PROVIDER>_AVAILABLE` .env var.
 *
 * Opt-out, not opt-in: an unset (or blank) var means available, so an existing .env keeps every
 * provider it has a key for and nobody has to add four lines to stand still. Only the literal "false"
 * switches one off — the same reading GRAPH_ENABLED gets elsewhere — and it is matched after trimming
 * and lowercasing so `False` and a trailing space behave as written.
 *
 * Both spellings of the name are read, the uppercase one documented in .env.example and the
 * all-lowercase one (`deepseek_available`), because .env files get written either way and an
 * availability switch that silently does nothing is a worse outcome than a second lookup.
 */
function providerAvailable(availabilityEnv: string, env: Record<string, string | undefined>): boolean {
  const raw = env[availabilityEnv] ?? env[availabilityEnv.toLowerCase()];
  return raw?.trim().toLowerCase() !== "false";
}

// The supported providers a workspace can actually choose: those with an API key configured that .env
// has not switched off. Drives the UI provider picker and GET /api/models, so neither an
// unauthenticated nor a disabled provider is ever offered. This is a usability filter, not
// enforcement: the PATCH route still validates against SUPPORTED_PROVIDERS, so a programmatic caller
// can still name a provider that isn't offered, and a workspace already stored on one keeps running
// it. Nothing here revokes a stored selection.
export function availableProviders(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(PROVIDERS)
    .filter(([, { apiKeyEnv, availabilityEnv }]) => {
      return Boolean(env[apiKeyEnv]?.trim()) && providerAvailable(availabilityEnv, env);
    })
    .map(([provider]) => provider);
}

/** Whether startup has at least one LLM provider that is both keyed and enabled. */
export function hasAvailableProvider(env: Record<string, string | undefined> = process.env): boolean {
  return availableProviders(env).length > 0;
}

/** What a provider accepts, assembled from the two registries that own the halves. */
function vocabularyFor(provider: string): ModelVocabulary {
  return { models: listModels(provider), reasoningEfforts: getProviderMetadata(provider).reasoningEfforts };
}

/**
 * The selection a workspace that has never picked one runs and displays.
 *
 * The RULE is firstAvailableSelection in lib/models/selection.ts; this supplies it with the two
 * things only the registry knows — which providers .env actually allows, and what each accepts.
 * It lives here rather than in the operations layer because the agent runtime needs it on every run
 * (loadAgentConfig), and an agent that reaches up into the trigger-facing layer for a provider fact
 * has the dependency backwards.
 *
 * "First" is registry order — PROVIDERS above, then the provider's list in lib/models/registry.ts —
 * filtered by availability. A deployment expresses a preference by reordering those lists or by
 * switching providers off, so there is no default constant that could name a provider it disallows.
 */
export function defaultModelSelection(env: Record<string, string | undefined> = process.env): ModelSelection {
  return firstAvailableSelection(availableProviders(env), vocabularyFor);
}

// The env var holding a provider's API key; undefined for an unknown provider (buildModel rejects it).
export function providerApiKeyEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.apiKeyEnv;
}

// The env var switching a provider off; undefined for an unknown provider. Exported for the same
// reason as providerApiKeyEnv: tests that clear the environment must be able to enumerate BOTH halves
// of every provider's .env contract from the registry. A hand-written list silently stops covering
// the newest provider, and the symptom is the worst kind — a developer's own shell leaking into a
// fallback-selection test, so it passes locally and fails in CI or vice versa.
export function providerAvailabilityEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.availabilityEnv;
}

// Total for legacy stored selections and validation paths that inspect metadata before rejecting an
// unknown provider. Unknown ids have no capabilities; they must never inherit another provider's.
export function getProviderMetadata(provider: string): ProviderMetadata {
  return PROVIDERS[provider] ?? { supportsPromptCaching: false, reasoningEfforts: [] };
}
