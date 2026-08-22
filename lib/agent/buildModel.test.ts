// The Anthropic thinking API split by model generation: newer models 400 on the legacy budget shape
// and need adaptive thinking + effort; older ones still take the legacy budget and reject effort.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ChatOpenAI } from "@langchain/openai";
import {
  anthropicThinkingConfig,
  availableProviders,
  buildChatModel,
  buildModel,
  defaultModelSelection,
  SUPPORTED_PROVIDERS,
  providerAvailabilityEnv,
} from "./buildModel";
import type { LLMProviderConfig } from "./interfaces";

describe("anthropicThinkingConfig", () => {
  it("uses adaptive thinking + effort for claude-sonnet-5", () => {
    const c = anthropicThinkingConfig("claude-sonnet-5", "high");
    expect(c).toEqual({ thinking: { type: "adaptive" }, outputConfig: { effort: "high" } });
    // No budget_tokens — that field is what 400s on this model.
    expect(c.thinking).not.toHaveProperty("budget_tokens");
  });

  it("uses adaptive thinking + effort for claude-opus-4-8", () => {
    const c = anthropicThinkingConfig("claude-opus-4-8", "medium");
    expect(c).toEqual({ thinking: { type: "adaptive" }, outputConfig: { effort: "medium" } });
  });

  it("maps the reasoning-effort knob straight onto output_config.effort", () => {
    expect(anthropicThinkingConfig("claude-opus-4-8", "low")).toMatchObject({
      outputConfig: { effort: "low" },
    });
  });

  it("uses the legacy enabled thinking budget for claude-haiku-4-5", () => {
    const c = anthropicThinkingConfig("claude-haiku-4-5", "high");
    expect(c).toEqual({ thinking: { type: "enabled", budget_tokens: 20_000 } });
    // No outputConfig.effort — Haiku 4.5 rejects effort.
    expect(c).not.toHaveProperty("outputConfig");
  });

  it("scales the legacy budget with reasoning effort", () => {
    expect(anthropicThinkingConfig("claude-haiku-4-5", "low")).toEqual({
      thinking: { type: "enabled", budget_tokens: 4_000 },
    });
    expect(anthropicThinkingConfig("claude-haiku-4-5", "medium")).toEqual({
      thinking: { type: "enabled", budget_tokens: 10_000 },
    });
  });

  it("defaults an unknown model to the legacy budget path", () => {
    const c = anthropicThinkingConfig("claude-some-future-model", "high");
    expect(c.thinking).toMatchObject({ type: "enabled" });
  });
});

// Where a config becomes a real client, so these assert the model/key actually reach the SDK.
// Targets buildChatModel: these are claims about vendor fields the ModelGateway deliberately hides.
describe("buildChatModel", () => {
  const config = (over: Partial<LLMProviderConfig>): LLMProviderConfig => ({
    provider: "openai",
    model: "gpt-5.5",
    apiKey: "test-key",
    reasoningEffort: "low",
    anthropicCacheTtl1h: false,
    ...over,
  });

  // The SDKs fall back to these on their own when passed no apiKey. A developer's shell still exports
  // them, and a build that picked one up would pass these assertions while proving nothing.
  const SDK_FALLBACK_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const env of SDK_FALLBACK_ENV) {
      saved[env] = process.env[env];
      delete process.env[env];
    }
  });
  afterEach(() => {
    for (const [env, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[env];
      else process.env[env] = v;
    }
  });

  it.each([
    ["anthropic", "claude-haiku-4-5"],
    ["openai", "gpt-5.5"],
    ["deepseek", "deepseek-v4-pro"],
    ["moonshot", "kimi-k3"],
    ["mistral", "mistral-medium-latest"],
    ["scaleway", "qwen3.6-35b-a3b"],
  ])("wires the selected model and key into the %s client", (provider, model) => {
    const m = buildChatModel(config({ provider, model, apiKey: `key-${provider}` })) as unknown as {
      model: string;
      apiKey: string;
    };
    expect(m.model).toBe(model);
    expect(m.apiKey).toBe(`key-${provider}`);
  });

  // These share OpenAI's client class, so a dropped `configuration` silently sends this vendor's key
  // to api.openai.com. Asserted on `clientConfig` because the `client` itself is built lazily.
  it.each([
    ["deepseek", "deepseek-v4-pro", "https://api.deepseek.com/v1"],
    ["moonshot", "kimi-k3", "https://api.moonshot.ai/v1"],
    ["mistral", "mistral-medium-latest", "https://api.mistral.ai/v1"],
    // Doubly load-bearing for Scaleway: the endpoint is the entire EU-sovereignty claim, so a
    // dropped override would send an EU customer's traffic to a US host while still looking correct.
    ["scaleway", "qwen3.6-35b-a3b", "https://api.scaleway.ai/v1"],
  ])("points %s at its own endpoint, never another vendor's", (provider, model, baseURL) => {
    const m = buildChatModel(config({ provider, model, apiKey: `key-${provider}` })) as unknown as {
      clientConfig: { baseURL?: string; apiKey?: string };
    };
    expect(m.clientConfig.baseURL).toBe(baseURL);
    expect(m.clientConfig.apiKey).toBe(`key-${provider}`);
  });

  // OpenAI itself is the one provider that must NOT carry an override: it talks to the SDK default.
  // Pinned separately because the assertion is the absence of a value, which no table row expresses.
  it("leaves openai on the SDK's default endpoint", () => {
    const m = buildChatModel(config({ provider: "openai" })) as unknown as {
      clientConfig: { baseURL?: string };
    };
    expect(m.clientConfig.baseURL).toBeUndefined();
  });

  // Kimi's "max" is absent from OpenAI's effort union, so it rides modelKwargs. A regression to the
  // typed field would silently drop it and run every turn at a lower effort.
  it("passes the Kimi reasoning effort through as a raw reasoning_effort request field", () => {
    const m = buildChatModel(config({ provider: "moonshot", model: "kimi-k3", reasoningEffort: "max" })) as unknown as {
      modelKwargs: Record<string, unknown>;
    };
    expect(m.modelKwargs).toEqual({ reasoning_effort: "max" });
  });

  // DeepSeek V4 thinks by default at "high", and its OpenAI-compatible reasoning_effort has no
  // "none" — so only the separate thinking field actually switches thinking off.
  it.each([
    ["max", { reasoning_effort: "max" }],
    ["low", { reasoning_effort: "low" }],
    ["none", { thinking: { type: "disabled" } }],
  ])("maps the DeepSeek effort %s onto its own request field", (reasoningEffort, expected) => {
    const m = buildChatModel(
      config({ provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: reasoningEffort as never }),
    ) as unknown as { modelKwargs: Record<string, unknown> };
    expect(m.modelKwargs).toEqual(expected);
  });

  // Scaleway serves DeepSeek's weights behind its OWN OpenAI-compatible API, where "none" is a
  // legal reasoning_effort. Routing it through DeepSeek's thinking field instead would 400.
  it.each(["none", "low", "high"])("sends the Scaleway effort %s as a plain reasoning_effort", (reasoningEffort) => {
    const m = buildChatModel(
      config({ provider: "scaleway", model: "deepseek-v4-flash-0731", reasoningEffort: reasoningEffort as never }),
    ) as unknown as { modelKwargs: Record<string, unknown> };
    expect(m.modelKwargs).toEqual({ reasoning_effort: reasoningEffort });
    expect(m.modelKwargs).not.toHaveProperty("thinking");
  });

  // Scaleway's gateway takes any level on any model and quietly collapses an unsupported one to that
  // model's default, so the snap has to happen here — qwen3.6 documents none|medium and nothing else.
  it("sends a Scaleway model only a level it documents", () => {
    const m = buildChatModel(
      config({ provider: "scaleway", model: "qwen3.6-35b-a3b", reasoningEffort: "low" }),
    ) as unknown as { modelKwargs: Record<string, unknown> };
    expect(m.modelKwargs).toEqual({ reasoning_effort: "medium" });
  });

  it.each([
    ["high", { reasoning_effort: "high" }],
    ["none", undefined],
  ])("maps the Mistral Medium thinking checkbox value %s", (reasoningEffort, expected) => {
    const m = buildChatModel(
      config({ provider: "mistral", model: "mistral-medium-latest", reasoningEffort: reasoningEffort as never }),
    ) as unknown as { modelKwargs?: Record<string, unknown> };
    expect(m.modelKwargs?.reasoning_effort).toBe(expected?.reasoning_effort);
  });

  it.each(["codestral-latest", "mistral-large-latest"])(
    "does not send reasoning_effort to %s, which does not support it",
    (model) => {
      const m = buildChatModel(config({ provider: "mistral", model, reasoningEffort: "high" })) as unknown as {
        modelKwargs?: Record<string, unknown>;
      };
      expect(m.modelKwargs ?? {}).not.toHaveProperty("reasoning_effort");
    },
  );

  // Asserted on the request body, not on modelKwargs: ChatOpenAI writes prompt_cache_key from its
  // typed field AFTER spreading modelKwargs, so a key parked in modelKwargs is overwritten with
  // undefined and never sent — a constructor-shaped assertion passes while nothing is ever cached.
  it("sends a stable Mistral prompt cache key without dropping reasoning configuration", () => {
    const m = buildChatModel(config({ provider: "mistral", model: "mistral-medium-latest", reasoningEffort: "high" }), {
      cacheScopeId: "conversation-42",
    }) as ChatOpenAI;

    expect(m.invocationParams({})).toMatchObject({
      reasoning_effort: "high",
      prompt_cache_key: "conversation-42",
    });

    const quiet = buildChatModel(
      config({ provider: "mistral", model: "mistral-medium-latest", reasoningEffort: "none" }),
      { cacheScopeId: "conversation-42" },
    ) as ChatOpenAI;
    const quietParams = quiet.invocationParams({}) as Record<string, unknown>;
    expect(quietParams.prompt_cache_key).toBe("conversation-42");
    expect(quietParams.reasoning_effort).toBeUndefined();
  });

  it.each([
    ["openai", "gpt-5.5"],
    ["anthropic", "claude-haiku-4-5"],
    ["deepseek", "deepseek-v4-pro"],
    ["moonshot", "kimi-k3"],
    ["scaleway", "qwen3.6-35b-a3b"],
  ])("does not leak the Mistral prompt cache key to %s", (provider, model) => {
    const m = buildChatModel(config({ provider, model }), {
      cacheScopeId: "conversation-42",
    }) as unknown as { modelKwargs?: Record<string, unknown>; promptCacheKey?: string };

    expect(m.modelKwargs ?? {}).not.toHaveProperty("prompt_cache_key");
    expect(m.promptCacheKey).toBeUndefined();
  });

  it("rejects an unregistered provider instead of falling back to another vendor's builder", () => {
    expect(() => buildChatModel(config({ provider: "retired-vendor" }))).toThrow(/unsupported LLM provider/);
  });

  it("rejects a config with no model rather than constructing an unusable client", () => {
    expect(() => buildChatModel(config({ model: "" }))).toThrow(/no model selected/);
  });

  // The seam itself: a buildModel handing back a bare SDK client would route the app around every
  // cross-cutting concern while still typechecking. Identity matters too — it is the policy key.
  it("hands callers a gateway rather than the vendor client", () => {
    const gateway = buildModel(config({ provider: "mistral", model: "mistral-medium-latest" }));
    expect(gateway.provider).toBe("mistral");
    expect(gateway.model).toBe("mistral-medium-latest");
    expect(typeof gateway.stream).toBe("function");
    expect(typeof gateway.invoke).toBe("function");
    // No vendor internals reachable through it — the tests above had to unwrap for a reason.
    expect(gateway).not.toHaveProperty("clientConfig");
    expect(gateway).not.toHaveProperty("apiKey");
  });

  it("keeps provider identity across bindTools, so bound and bare calls share one policy", () => {
    const gateway = buildModel(config({ provider: "mistral", model: "mistral-medium-latest" })).bindTools([]);
    expect(gateway.provider).toBe("mistral");
    expect(gateway.model).toBe("mistral-medium-latest");
  });

  // Iterates the registry rather than naming providers: a sixth entry that forgets NO_SDK_RETRY fails
  // here, instead of silently retrying 6 times behind whatever pacing the gateway applies.
  it("disables SDK-level retries on every provider", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      const chat = buildChatModel(config({ provider, model: "test-model" }));
      const { caller } = chat as unknown as { caller: { maxRetries: number } };
      expect(caller.maxRetries, `${provider} must not retry on its own`).toBe(0);
    }
  });
});

// Availability is the ONLY question .env answers about a provider. Keys are entered in the app, so
// the assertions below say nothing about them — the function no longer knows they exist.
describe("availableProviders", () => {
  it("offers every supported provider when nothing is switched off", () => {
    // Not a hand-listed expectation: adding a provider must extend this automatically, or the test
    // quietly stops covering the newest one.
    expect(availableProviders({})).toEqual(SUPPORTED_PROVIDERS);
  });

  it("offers a provider that has no API key, so a fresh deployment has something to pick", () => {
    // The bug this replaces: requiring a key here meant a deployment with none served an empty
    // picker, and the keys can only be entered through that picker's own settings modal.
    expect(availableProviders({})).toContain("anthropic");
  });

  it("drops a provider .env switched off", () => {
    expect(availableProviders({ ANTHROPIC_AVAILABLE: "false" })).not.toContain("anthropic");
  });

  it("keeps a provider whose availability var is unset, blank, or true", () => {
    // Opt-out: an .env written before the switch existed must keep every provider standing.
    for (const env of [{}, { DEEPSEEK_AVAILABLE: "" }, { DEEPSEEK_AVAILABLE: "true" }]) {
      expect(availableProviders(env)).toContain("deepseek");
    }
  });

  it("reads the switch case-insensitively, trimmed, and in the lowercase spelling", () => {
    expect(availableProviders({ OPENAI_AVAILABLE: "False" })).not.toContain("openai");
    expect(availableProviders({ OPENAI_AVAILABLE: " false " })).not.toContain("openai");
    expect(availableProviders({ openai_available: "false" })).not.toContain("openai");
  });

  it("ignores a value that is neither true nor false rather than guessing it meant off", () => {
    // Only the literal "false" disables, matching GRAPH_ENABLED. A typo leaves the provider offered,
    // which fails visibly in the picker rather than making a provider vanish for an unreadable reason.
    expect(availableProviders({ OPENAI_AVAILABLE: "no" })).toContain("openai");
  });

  it("returns nothing when every provider is switched off", () => {
    const allOff = Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [providerAvailabilityEnv(p)!, "false"]));
    expect(availableProviders(allOff)).toEqual([]);
  });
});

describe("defaultModelSelection", () => {
  // Every case switches providers off rather than keying them on, because that is now the only lever.
  const only = (provider: string) =>
    Object.fromEntries(
      SUPPORTED_PROVIDERS.filter((p) => p !== provider).map((p) => [providerAvailabilityEnv(p)!, "false"]),
    );

  it("takes the first available provider's first model", () => {
    expect(defaultModelSelection(only("deepseek"))).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      // No effort dial, so the stored value is the uniform placeholder the agent never sends.
      reasoningEffort: "low",
    });
  });

  it("takes the provider's default effort when it has a dial", () => {
    expect(defaultModelSelection(only("anthropic"))).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoningEffort: "low",
    });
  });

  it("skips a provider switched off in favour of the next one offered", () => {
    expect(defaultModelSelection({ ANTHROPIC_AVAILABLE: "false" }).provider).toBe("openai");
  });

  // No longer a hypothetical corner: with keys out of .env, a deployment that switches everything
  // off still starts, and this is what its workspaces report until something is switched back on.
  it("returns empty fields when every provider is switched off", () => {
    const allOff = Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [providerAvailabilityEnv(p)!, "false"]));
    expect(defaultModelSelection(allOff)).toEqual({ provider: "", model: "", reasoningEffort: "low" });
  });

  it("picks a provider that has no API key rather than skipping to a keyed one", () => {
    // Deliberate: the picker shows a real default from first boot, and the missing key is reported at
    // conversation start where it names the fix. Hiding it would show an empty picker instead.
    expect(defaultModelSelection({}).provider).toBe(SUPPORTED_PROVIDERS[0]);
  });
});
