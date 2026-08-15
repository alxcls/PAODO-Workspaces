// The Anthropic thinking API split by model generation: newer models (Opus 4.7+, Sonnet 5) reject
// the legacy thinking:{type:"enabled", budget_tokens} shape with a 400 and require adaptive thinking
// + output_config.effort; older models (Haiku 4.5) still take the legacy budget and reject effort.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  anthropicThinkingConfig,
  availableProviders,
  buildModel,
  defaultModelSelection,
  hasAvailableProvider,
  SUPPORTED_PROVIDERS,
  providerApiKeyEnv,
} from "./buildModel";
import type { LLMProviderConfig } from "./interfaces";
import type { ReasoningEffort } from "../models/llmSelection";

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

// The builders are the single point where a config becomes a real client, so these assert that the
// selected model/key actually reach the SDK. Every provider's key env var is cleared first: the SDKs
// fall back to process.env on their own, which would mask a builder that never wired the key through.
describe("buildModel", () => {
  const config = (over: Partial<LLMProviderConfig>): LLMProviderConfig => ({
    provider: "openai",
    model: "gpt-5.5",
    apiKey: "test-key",
    reasoningEffort: "low",
    anthropicCacheTtl1h: false,
    ...over,
  });

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const p of SUPPORTED_PROVIDERS) {
      const env = providerApiKeyEnv(p)!;
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
    ["mistral", "mistral-small-2603"],
  ])("wires the selected model and key into the %s client", (provider, model) => {
    const m = buildModel(config({ provider, model, apiKey: `key-${provider}` })) as unknown as {
      model: string;
      apiKey: string;
    };
    expect(m.model).toBe(model);
    expect(m.apiKey).toBe(`key-${provider}`);
  });

  // Every OpenAI-compatible provider is the SAME client class as OpenAI itself, so the base URL is
  // the only thing separating them. Nothing else in the suite pins it: a dropped or mistyped
  // `configuration` doesn't fail loudly, it silently sends this provider's key to api.openai.com —
  // one vendor's credential handed to another vendor, surfacing as a puzzling 401 rather than a
  // visible bug. Assert the endpoint per provider so that can't happen quietly.
  //
  // `clientConfig` is where @langchain/openai lands the `configuration` object at construction time
  // (base.js merges it into this.clientConfig in the constructor). The `client` it eventually builds
  // is lazy — created on the first request — so it is still undefined here and cannot be asserted on.
  it.each([
    ["deepseek", "deepseek-v4-pro", "https://api.deepseek.com/v1"],
    ["moonshot", "kimi-k3", "https://api.moonshot.ai/v1"],
    ["mistral", "mistral-small-2603", "https://api.mistral.ai/v1"],
  ])("points %s at its own endpoint, never another vendor's", (provider, model, baseURL) => {
    const m = buildModel(config({ provider, model, apiKey: `key-${provider}` })) as unknown as {
      clientConfig: { baseURL?: string; apiKey?: string };
    };
    expect(m.clientConfig.baseURL).toBe(baseURL);
    expect(m.clientConfig.apiKey).toBe(`key-${provider}`);
  });

  // OpenAI itself is the one provider that must NOT carry an override: it talks to the SDK default.
  // Pinned separately because the assertion is the absence of a value, which no table row expresses.
  it("leaves openai on the SDK's default endpoint", () => {
    const m = buildModel(config({ provider: "openai" })) as unknown as {
      clientConfig: { baseURL?: string };
    };
    expect(m.clientConfig.baseURL).toBeUndefined();
  });

  // Kimi's strongest effort is "max", which OpenAI's effort union doesn't have — so it can't ride the
  // typed `reasoningEffort` field and goes through modelKwargs instead. If that ever regresses to the
  // typed field, "max" would be dropped or rejected and every turn would silently run at a lower
  // effort, so assert the raw request field carries the value the workspace picked.
  it("passes the Kimi reasoning effort through as a raw reasoning_effort request field", () => {
    const m = buildModel(config({ provider: "moonshot", model: "kimi-k3", reasoningEffort: "max" })) as unknown as {
      modelKwargs: Record<string, unknown>;
    };
    expect(m.modelKwargs).toEqual({ reasoning_effort: "max" });
  });

  // Mistral is the first provider whose models disagree about thinking, so the reasoning field is
  // decided per model rather than per provider. Getting this wrong fails in two different ways: send
  // reasoning_effort to a magistral model and the API answers 400 outright ("always" models reject
  // the field even when it agrees with them); omit it on Small 4 and thinking silently never happens.
  // Both are invisible from the picker, which is why they are pinned on the request body here.
  it.each([
    ["mistral-small-2603", "high", { reasoning_effort: "high" }],
    ["mistral-small-2603", "none", { reasoning_effort: "none" }],
    ["mistral-medium-2604", "high", { reasoning_effort: "high" }],
  ])("sends reasoning_effort for the toggle model %s at %s", (model, effort, expected) => {
    const m = buildModel(
      config({ provider: "mistral", model, reasoningEffort: effort as ReasoningEffort }),
    ) as unknown as { modelKwargs?: Record<string, unknown> };
    expect(m.modelKwargs).toEqual(expected);
  });

  it.each([
    ["magistral-medium-latest", "reasons natively and 400s if the field is present at all"],
    ["magistral-small-latest", "reasons natively and 400s if the field is present at all"],
    ["codestral-2508", "has no thinking mode to address"],
    ["ministral-3-3b-2512", "has no thinking mode to address"],
  ])("omits reasoning_effort entirely for %s — it %s", (model) => {
    const m = buildModel(config({ provider: "mistral", model, reasoningEffort: "high" })) as unknown as {
      modelKwargs?: Record<string, unknown>;
    };
    // Absence of the KEY is the contract, not an absent modelKwargs object: ChatOpenAI defaults that
    // to {}, and an empty object contributes no field to the request body. What must never appear is
    // reasoning_effort itself — for the magistral pair its mere presence is the 400.
    expect(m.modelKwargs ?? {}).not.toHaveProperty("reasoning_effort");
  });

  // A workspace carried onto mistral from a provider with a richer dial can still hold "max" or
  // "medium" in storage. Mistral knows only none|high, so anything that isn't off must arrive as
  // "high" rather than be forwarded verbatim into a 400.
  it("collapses an effort level mistral doesn't know rather than forwarding it", () => {
    const m = buildModel(
      config({ provider: "mistral", model: "mistral-small-2603", reasoningEffort: "max" }),
    ) as unknown as { modelKwargs: Record<string, unknown> };
    expect(m.modelKwargs).toEqual({ reasoning_effort: "high" });
  });

  it("rejects an unregistered provider instead of falling back to another vendor's builder", () => {
    expect(() => buildModel(config({ provider: "retired-vendor" }))).toThrow(/unsupported LLM provider/);
  });

  it("rejects a config with no model rather than constructing an unusable client", () => {
    expect(() => buildModel(config({ model: "" }))).toThrow(/no model selected/);
  });
});

describe("availableProviders", () => {
  it("lists only providers whose key is set, so the picker can't offer an unauthenticated one", () => {
    expect(availableProviders({ ANTHROPIC_API_KEY: "sk-ant", DEEPSEEK_API_KEY: "sk-ds" })).toEqual([
      "anthropic",
      "deepseek",
    ]);
  });

  it("treats blank and whitespace-only keys as unset", () => {
    expect(availableProviders({ OPENAI_API_KEY: " ", ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "\t" })).toEqual([]);
  });

  it("returns a subset of the supported providers", () => {
    // Env built from the registry rather than a hand-listed set, so adding a provider can't leave
    // this asserting a stale list.
    const all = availableProviders(Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [providerApiKeyEnv(p)!, "k"])));
    expect(all).toEqual(SUPPORTED_PROVIDERS);
  });

  it("drops a keyed provider that .env switched off", () => {
    expect(
      availableProviders({
        ANTHROPIC_API_KEY: "sk-ant",
        DEEPSEEK_API_KEY: "sk-ds",
        ANTHROPIC_AVAILABLE: "false",
      }),
    ).toEqual(["deepseek"]);
  });

  it("keeps a provider whose availability var is unset, blank, or true", () => {
    // Opt-out: an .env written before the switch existed must keep every provider it has a key for.
    expect(availableProviders({ DEEPSEEK_API_KEY: "sk-ds" })).toEqual(["deepseek"]);
    expect(availableProviders({ DEEPSEEK_API_KEY: "sk-ds", DEEPSEEK_AVAILABLE: "" })).toEqual(["deepseek"]);
    expect(availableProviders({ DEEPSEEK_API_KEY: "sk-ds", DEEPSEEK_AVAILABLE: "true" })).toEqual(["deepseek"]);
  });

  it("reads the switch case-insensitively, trimmed, and in the lowercase spelling", () => {
    expect(availableProviders({ OPENAI_API_KEY: "sk", OPENAI_AVAILABLE: "False" })).toEqual([]);
    expect(availableProviders({ OPENAI_API_KEY: "sk", OPENAI_AVAILABLE: " false " })).toEqual([]);
    expect(availableProviders({ OPENAI_API_KEY: "sk", openai_available: "false" })).toEqual([]);
  });

  it("ignores a value that is neither true nor false rather than guessing it meant off", () => {
    // Only the literal "false" disables, matching GRAPH_ENABLED. A typo leaves the provider offered,
    // which fails visibly in the picker rather than making a provider vanish for an unreadable reason.
    expect(availableProviders({ OPENAI_API_KEY: "sk", OPENAI_AVAILABLE: "no" })).toEqual(["openai"]);
  });
});

describe("hasAvailableProvider", () => {
  it("returns false when every supported provider key is absent or blank", () => {
    expect(hasAvailableProvider({})).toBe(false);
    expect(
      hasAvailableProvider({
        OPENAI_API_KEY: " ",
        ANTHROPIC_API_KEY: "",
        DEEPSEEK_API_KEY: "\t",
      }),
    ).toBe(false);
  });

  it("returns true when any supported provider key is configured", () => {
    expect(hasAvailableProvider({ OPENAI_API_KEY: "sk-test" })).toBe(true);
  });

  it("returns false when the only keyed provider is switched off", () => {
    // Startup refuses in production: a key nobody is allowed to use is not a usable provider.
    expect(hasAvailableProvider({ OPENAI_API_KEY: "sk-test", OPENAI_AVAILABLE: "false" })).toBe(false);
  });
});
describe("defaultModelSelection", () => {
  it("takes the first available provider's first model", () => {
    expect(defaultModelSelection({ DEEPSEEK_API_KEY: "k" })).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      // No effort dial, so the stored value is the uniform placeholder the agent never sends.
      reasoningEffort: "low",
    });
  });

  it("takes the provider's default effort when it has a dial", () => {
    expect(defaultModelSelection({ ANTHROPIC_API_KEY: "k" })).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoningEffort: "low",
    });
  });

  // The reported bug: a workspace that never picked showed and ran deepseek even with the switch off.
  it("never picks a provider that is unkeyed or switched off", () => {
    expect(
      defaultModelSelection({
        ANTHROPIC_API_KEY: "k",
        DEEPSEEK_API_KEY: "k",
        ANTHROPIC_AVAILABLE: "false",
      }).provider,
    ).toBe("deepseek");
    expect(defaultModelSelection({ DEEPSEEK_API_KEY: "k", DEEPSEEK_AVAILABLE: "false" }).provider).toBe("");
  });

  it("returns empty fields when no provider is available at all", () => {
    // Production startup refuses in this state; dev shows an empty picker rather than a provider it
    // cannot use.
    expect(defaultModelSelection({})).toEqual({ provider: "", model: "", reasoningEffort: "low" });
  });
});
