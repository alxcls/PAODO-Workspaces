// The Anthropic thinking API split by model generation: newer models (Opus 4.7+, Sonnet 5) reject
// the legacy thinking:{type:"enabled", budget_tokens} shape with a 400 and require adaptive thinking
// + output_config.effort; older models (Haiku 4.5) still take the legacy budget and reject effort.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  anthropicThinkingConfig,
  buildModel,
  hasConfiguredProviderApiKey,
  SUPPORTED_PROVIDERS,
  providerApiKeyEnv,
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
  ])("wires the selected model and key into the %s client", (provider, model) => {
    const m = buildModel(config({ provider, model, apiKey: `key-${provider}` })) as unknown as {
      model: string;
      apiKey: string;
    };
    expect(m.model).toBe(model);
    expect(m.apiKey).toBe(`key-${provider}`);
  });

  it("rejects an unregistered provider instead of falling back to another vendor's builder", () => {
    expect(() => buildModel(config({ provider: "retired-vendor" }))).toThrow(/unsupported LLM provider/);
  });

  it("rejects a config with no model rather than constructing an unusable client", () => {
    expect(() => buildModel(config({ model: "" }))).toThrow(/no model selected/);
  });
});

describe("hasConfiguredProviderApiKey", () => {
  it("returns false when every supported provider key is absent or blank", () => {
    expect(hasConfiguredProviderApiKey({})).toBe(false);
    expect(
      hasConfiguredProviderApiKey({
        OPENAI_API_KEY: " ",
        ANTHROPIC_API_KEY: "",
        DEEPSEEK_API_KEY: "\t",
      }),
    ).toBe(false);
  });

  it("returns true when any supported provider key is configured", () => {
    expect(hasConfiguredProviderApiKey({ OPENAI_API_KEY: "sk-test" })).toBe(true);
  });
});
