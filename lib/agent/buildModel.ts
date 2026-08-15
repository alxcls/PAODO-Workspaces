// The provider registry: what each provider accepts, which .env var offers it, and how to build its
// client. Server-only; vendor objects never leave here, and keys come from providerKeyStore, not .env.

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { LLMProviderConfig } from "./interfaces";
import { createModelGateway, type ModelCallObserver, type ModelGateway } from "./modelGateway";
import { mistralReasoningConfig } from "./mistralProtocol";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "../models/llmSelection";
import { listModels } from "../models/registry";
import { firstAvailableSelection, type ModelSelection, type ModelVocabulary } from "../models/selection";

// Legacy extended-thinking budgets, keyed by the workspace's reasoning-effort knob. Used only for
// models that still accept thinking:{type:"enabled", budget_tokens} — see ANTHROPIC_ADAPTIVE_MODELS.
const ANTHROPIC_THINKING_BUDGET: Partial<Record<ReasoningEffort, number>> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 32_000,
  max: 48_000,
};

// Models requiring adaptive thinking + output_config.effort, which 400 on the legacy budget_tokens
// shape. A registry model absent here falls through to legacy — correct for haiku-4-5, which 400s on effort.
const ANTHROPIC_ADAPTIVE_MODELS = new Set<string>(["claude-opus-4-8", "claude-sonnet-5"]);

// An Anthropic model's thinking fields. Newer models take adaptive thinking, and the effort knob maps
// straight onto output_config.effort; older ones take the legacy fixed budget and reject effort.
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
  // The effort levels this provider accepts, quietest first. Drives BOTH the picker and API-side
  // validation, so the UI cannot offer a rejected level. Empty means no dial, and the UI hides it.
  reasoningEfforts: ReasoningEffort[];
}

interface ProviderDescriptor extends ProviderMetadata {
  /**
   * The .env var that switches this provider off for the whole deployment — now the provider's ONLY
   * env contract. Its API key is not in .env at all: it is entered in the app and held encrypted by
   * lib/infra/security/providerKeyStore.ts, so a deployment can be handed over without its keys.
   *
   * Named per provider rather than derived from the id, so the var is greppable from the registry.
   */
  availabilityEnv: string;
  build: (config: LLMProviderConfig) => ChatOpenAI | ChatAnthropic;
}

// Retries belong to us, not the SDK. Left alone, LangChain's AsyncCaller silently retries 6 times
// with backoff, hiding the refusals the gateway has to pace around. Every build spreads this.
const NO_SDK_RETRY = { maxRetries: 0 } as const;

// The single source of truth for provider support. Adding one means an entry here plus its models in
// lib/models/registry.ts — nothing else in the agent layer changes, and nothing in .env.
const PROVIDERS: Record<string, ProviderDescriptor> = {
  anthropic: {
    availabilityEnv: "ANTHROPIC_AVAILABLE",
    supportsPromptCaching: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    build: (config) =>
      new ChatAnthropic({
        model: config.model,
        apiKey: config.apiKey,
        ...NO_SDK_RETRY,
        ...anthropicThinkingConfig(config.model, config.reasoningEffort),
        ...(config.anthropicCacheTtl1h && {
          clientOptions: {
            defaultHeaders: { "anthropic-beta": "prompt-caching-scope-2026-01-05" },
          },
        }),
      }),
  },
  openai: {
    availabilityEnv: "OPENAI_AVAILABLE",
    supportsPromptCaching: false,
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    build: (config) => {
      // OpenAI takes none…xhigh, never "max" (validation keeps it out). "none" disables reasoning, so
      // the summary request is omitted — there would be nothing to summarize.
      const effort = config.reasoningEffort as Exclude<ReasoningEffort, "max">;
      return new ChatOpenAI({
        model: config.model,
        // `apiKey`, not the legacy `openAIApiKey` alias — the latter is silently ignored by
        // @langchain/openai v1, which then falls back to process.env.OPENAI_API_KEY on its own.
        apiKey: config.apiKey,
        ...NO_SDK_RETRY,
        useResponsesApi: true,
        reasoning: effort === "none" ? { effort } : { effort, summary: "auto" },
      });
    },
  },
  deepseek: {
    availabilityEnv: "DEEPSEEK_AVAILABLE",
    supportsPromptCaching: false,
    reasoningEfforts: [],
    build: (config) =>
      new ChatOpenAI({
        model: config.model,
        ...NO_SDK_RETRY,
        configuration: {
          baseURL: "https://api.deepseek.com/v1",
          apiKey: config.apiKey,
        },
      }),
  },
  moonshot: {
    availabilityEnv: "MOONSHOT_AVAILABLE",
    supportsPromptCaching: false,
    // Kimi K3 takes low|high|max only — no medium, and none/minimal aren't offered because K3 always
    // thinks. The narrower list is why the effort knob is validated per provider rather than globally.
    reasoningEfforts: ["low", "high", "max"],
    build: (config) =>
      new ChatOpenAI({
        model: config.model,
        ...NO_SDK_RETRY,
        configuration: {
          baseURL: "https://api.moonshot.ai/v1",
          apiKey: config.apiKey,
        },
        // modelKwargs, not the typed `reasoningEffort`: that field is OpenAI's union, which has no
        // "max" — Kimi's strongest level. modelKwargs is spread verbatim into the request body.
        modelKwargs: { reasoning_effort: config.reasoningEffort },
      }),
  },
  mistral: {
    availabilityEnv: "MISTRAL_AVAILABLE",
    // This flag controls Anthropic-style cache_control markers; Mistral does not use those markers.
    supportsPromptCaching: false,
    // Medium exposes a simple on/off checkbox: none disables reasoning, high enables it.
    reasoningEfforts: [THINKING_OFF_EFFORT, "high"],
    build: (config) =>
      new ChatOpenAI({
        model: config.model,
        ...NO_SDK_RETRY,
        configuration: {
          baseURL: "https://api.mistral.ai/v1",
          apiKey: config.apiKey,
        },
        ...mistralReasoningConfig(config.model, config.reasoningEffort),
      }),
  },
};

/**
 * The vendor client for a config, unwrapped.
 *
 * RUNTIME CODE MUST NOT CALL THIS — buildModel is the entry point. A bare client is a provider call
 * that nothing measures and, once pacing lands, nothing paces; that is the whole reason the gateway
 * exists. It is split out and exported only so the registry's wiring (model id, key, base URL,
 * reasoning fields) stays directly assertable, which is a claim about the SDK object and cannot be
 * made through an interface that deliberately hides it.
 */
export function buildChatModel(config: LLMProviderConfig): ChatOpenAI | ChatAnthropic {
  const descriptor = PROVIDERS[config.provider];
  // Unknown providers fail loudly here rather than silently resolving to another vendor's builder:
  // the API validates provider on write, so reaching this means a retired provider is still stored.
  if (!descriptor) {
    throw new Error(`unsupported LLM provider "${config.provider}" (supported: ${SUPPORTED_PROVIDERS.join(", ")})`);
  }
  if (!config.model) throw new Error(`no model selected for provider "${config.provider}"`);
  return descriptor.build(config);
}

/**
 * The model for one run, as a ModelGateway rather than a vendor object.
 *
 * The SDK instance stops here. Callers get the gateway (./modelGateway.ts), which is where anything
 * true of every model call belongs — so a provider added above cannot arrive with its own
 * accounting, and a new call site cannot bypass it.
 */
export function buildModel(config: LLMProviderConfig, options: { observe?: ModelCallObserver } = {}): ModelGateway {
  return createModelGateway(buildChatModel(config), {
    provider: config.provider,
    model: config.model,
    ...(options.observe ? { observe: options.observe } : {}),
  });
}

// The providers the app supports — the source of truth for the UI provider picker and the API-side
// validation of a workspace's stored provider. Derived from the registry so it can't drift.
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

/**
 * Whether a provider is offered in this deployment, per its `<PROVIDER>_AVAILABLE` .env var.
 *
 * Opt-out, not opt-in: an unset (or blank) var means available, so a deployment offers every provider
 * the app supports until it says otherwise and nobody has to add five lines to stand still. Only the
 * literal "false" switches one off — the same reading GRAPH_ENABLED gets elsewhere — and it is
 * matched after trimming and lowercasing so `False` and a trailing space behave as written.
 *
 * Both spellings of the name are read, the uppercase one documented in .env.example and the
 * all-lowercase one (`deepseek_available`), because .env files get written either way and an
 * availability switch that silently does nothing is a worse outcome than a second lookup.
 */
function providerAvailable(availabilityEnv: string, env: Record<string, string | undefined>): boolean {
  const raw = env[availabilityEnv] ?? env[availabilityEnv.toLowerCase()];
  return raw?.trim().toLowerCase() !== "false";
}

/**
 * The providers this deployment offers: every supported one .env has not switched off.
 *
 * DELIBERATELY SAYS NOTHING ABOUT KEYS. It used to also require an API key in .env, which made one
 * list serve two questions — "what may be chosen" and "what can authenticate" — and that conflation
 * is what made a keyless deployment show an empty picker. A provider is offered whether or not
 * anyone has entered its key; whether it can actually run is `hasProviderKey`, asked separately and
 * answered at conversation start.
 *
 * Drives the UI provider picker, GET /api/models, and which providers may be given a key at all.
 * That last one is what gives the switch teeth: a withdrawn provider cannot be keyed, and any key it
 * already had is purged at startup (purgeProviderKeysExcept).
 */
export function availableProviders(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(PROVIDERS)
    .filter(([, { availabilityEnv }]) => providerAvailable(availabilityEnv, env))
    .map(([provider]) => provider);
}

/** What a provider accepts, assembled from the two registries that own the halves. */
function vocabularyFor(provider: string): ModelVocabulary {
  return { models: listModels(provider), reasoningEfforts: getProviderMetadata(provider).reasoningEfforts };
}

/**
 * The selection a workspace that has never picked one runs and displays.
 *
 * The RULE is firstAvailableSelection in lib/models/selection.ts; this supplies it with the two
 * things only the registry knows — which providers .env allows, and what each accepts. It lives here
 * rather than in the operations layer because the agent runtime needs it on every run
 * (loadAgentConfig), and an agent that reaches up into the trigger-facing layer for a provider fact
 * has the dependency backwards.
 *
 * "First" is registry order — PROVIDERS above, then the provider's list in lib/models/registry.ts —
 * filtered by availability. A deployment expresses a preference by reordering those lists or by
 * switching providers off, so there is no default constant that could name a provider it disallows.
 *
 * The result may well name a provider with no API key set. That is correct and intended: the picker
 * shows a real choice from the first boot, before anyone has entered a key, and the missing key is
 * reported where it can be acted on rather than by hiding the provider.
 */
export function defaultModelSelection(env: Record<string, string | undefined> = process.env): ModelSelection {
  return firstAvailableSelection(availableProviders(env), vocabularyFor);
}

// The env var switching a provider off. Exported so env-clearing tests enumerate the contract from
// the registry, not a hand-written list that quietly stops covering the newest provider.
export function providerAvailabilityEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.availabilityEnv;
}

// Total for legacy stored selections and validation paths that inspect metadata before rejecting an
// unknown provider. Unknown ids have no capabilities; they must never inherit another provider's.
export function getProviderMetadata(provider: string): ProviderMetadata {
  return PROVIDERS[provider] ?? { supportsPromptCaching: false, reasoningEfforts: [] };
}
