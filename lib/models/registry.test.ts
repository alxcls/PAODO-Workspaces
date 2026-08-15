// The model catalog is a code-owned list of the models offered in the picker. What matters: it
// covers exactly the supported providers, listModels reflects it, an unknown provider yields an
// empty list, and every listed model has a matching pricing entry so its usage cost resolves.
import { describe, it, expect } from "vitest";
import { AVAILABLE_MODELS, listModels, offeredModelIds, thinkingSupport } from "./registry";
import { getRate } from "./pricing";
import { SUPPORTED_PROVIDERS, getProviderMetadata } from "@/lib/agent/buildModel";
import { THINKING_OFF_EFFORT } from "./llmSelection";

describe("models catalog", () => {
  it("lists a provider's models from the curated catalog", () => {
    expect(listModels("anthropic")).toContain("claude-opus-4-8");
    // Order matters for deepseek: the first entry is what a bare provider choice resolves to.
    expect(listModels("deepseek")).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(listModels("moonshot")).toContain("kimi-k3");
  });

  it("returns an empty list for an unknown provider", () => {
    expect(listModels("not-a-provider")).toEqual([]);
  });

  it("only lists models for supported providers", () => {
    for (const provider of Object.keys(AVAILABLE_MODELS)) {
      expect(SUPPORTED_PROVIDERS).toContain(provider);
    }
  });

  // Every supported provider must serve at least one model: the fallback selection is the first
  // available provider's first model, so an empty list would resolve to no model at all.
  it("offers at least one model for every supported provider", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(listModels(provider).length, `no models for ${provider}`).toBeGreaterThan(0);
    }
  });

  it("exposes each provider's accepted reasoning-effort levels; empty hides the control", () => {
    // The levels come from the installed SDK unions and differ per provider; deepseek has no dial.
    expect(getProviderMetadata("anthropic").reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getProviderMetadata("openai").reasoningEfforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getProviderMetadata("deepseek").reasoningEfforts).toEqual([]);
    // Kimi K3 accepts low|high|max — no medium, and it always thinks, so none/minimal aren't offered.
    expect(getProviderMetadata("moonshot").reasoningEfforts).toEqual(["low", "high", "max"]);
    // Mistral's dial is binary, which is why the picker renders it as a checkbox rather than a
    // dropdown: two levels where one of them means "off" is a boolean wearing a dropdown's clothes.
    expect(getProviderMetadata("mistral").reasoningEfforts).toEqual(["none", "high"]);
  });

  it("has a resolvable price for every offered model", () => {
    for (const model of offeredModelIds()) {
      expect(getRate(model), `missing pricing for ${model}`).toBeDefined();
    }
  });

  // A model that can switch thinking off needs somewhere to store "off", and that somewhere is
  // reasoningEffort === "none". A provider offering a toggle model without "none" in its accepted
  // levels would leave the picker's unchecked box unrepresentable — validateMetadata would reject
  // the very value the checkbox produces, so the control would appear to work and then fail on save.
  it("gives every toggle model's provider a way to store thinking-off", () => {
    for (const [provider, entries] of Object.entries(AVAILABLE_MODELS)) {
      const efforts = getProviderMetadata(provider).reasoningEfforts;
      for (const entry of entries) {
        if (entry.thinking !== "toggle") continue;
        expect(efforts, `${provider}/${entry.id} toggles but cannot store "off"`).toContain(THINKING_OFF_EFFORT);
      }
    }
  });

  // Unknown ids must not inherit a thinking mode. A workspace's llmModel is free-form (the PATCH
  // route accepts an id this catalog hasn't listed yet), and claiming it thinks would send a
  // reasoning field the provider may well reject.
  it("reports no thinking for a model this catalog doesn't list", () => {
    expect(thinkingSupport("mistral", "not-a-model")).toBe("never");
    expect(thinkingSupport("not-a-provider", "mistral-small-2603")).toBe("never");
  });

  // Mistral is the reason thinking is per-model rather than per-provider: all three kinds live under
  // one provider id, so a provider-level flag could not describe it without lying about 9 of 11.
  it("classifies mistral's models individually, not by provider", () => {
    expect(thinkingSupport("mistral", "mistral-small-2603")).toBe("toggle");
    expect(thinkingSupport("mistral", "mistral-medium-2604")).toBe("toggle");
    // Magistral reasons natively and 400s if reasoning_effort is sent at all — "always", not "toggle".
    expect(thinkingSupport("mistral", "magistral-medium-latest")).toBe("always");
    expect(thinkingSupport("mistral", "codestral-2508")).toBe("never");
  });
});
