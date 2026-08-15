// The model catalog is a code-owned list of the models offered in the picker. What matters: it
// covers exactly the supported providers, listModels reflects it, an unknown provider yields an
// empty list, and every listed model has a matching pricing entry so its usage cost resolves.
import { describe, it, expect } from "vitest";
import { AVAILABLE_MODELS, listModels, offeredModelIds } from "./registry";
import { getRate } from "./pricing";
import { SUPPORTED_PROVIDERS, getProviderMetadata } from "@/lib/agent/buildModel";

describe("models catalog", () => {
  it("lists a provider's models from the curated catalog", () => {
    expect(listModels("anthropic")).toContain("claude-opus-4-8");
    // Order matters for deepseek: the first entry is what a bare provider choice resolves to.
    expect(listModels("deepseek")).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(listModels("moonshot")).toContain("kimi-k3");
    expect(listModels("mistral")).toEqual(["mistral-large-latest", "mistral-medium-latest"]);
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
    // Medium exposes one binary choice: off or Mistral's supported high reasoning mode.
    expect(getProviderMetadata("mistral").reasoningEfforts).toEqual(["none", "high"]);
  });

  it("has a resolvable price for every offered model", () => {
    for (const model of offeredModelIds()) {
      expect(getRate(model), `missing pricing for ${model}`).toBeDefined();
    }
  });
});
