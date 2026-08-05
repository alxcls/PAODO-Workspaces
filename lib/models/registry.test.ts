// The model catalog is a code-owned list of the models offered in the picker. What matters: it
// covers exactly the supported providers, listModels reflects it, an unknown provider yields an
// empty list, and every listed model has a matching pricing entry so its usage cost resolves.
import { describe, it, expect } from "vitest";
import { AVAILABLE_MODELS, listModels } from "./registry";
import { getRate } from "./pricing";
import { SUPPORTED_PROVIDERS, getProviderMetadata } from "@/lib/agent/buildModel";
import { DEFAULT_LLM } from "@/lib/models/llmSelection";

describe("models catalog", () => {
  it("lists a provider's models from the curated catalog", () => {
    expect(listModels("anthropic")).toContain("claude-opus-4-8");
    expect(listModels("deepseek")).toContain("deepseek-v4-pro");
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

  it("offers the default model in its provider's list", () => {
    expect(listModels(DEFAULT_LLM.provider)).toContain(DEFAULT_LLM.model);
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
  });

  it("has a resolvable price for every offered model", () => {
    for (const models of Object.values(AVAILABLE_MODELS)) {
      for (const model of models) {
        expect(getRate(model), `missing pricing for ${model}`).toBeDefined();
      }
    }
  });
});
