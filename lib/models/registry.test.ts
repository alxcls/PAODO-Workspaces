// The code-owned list of models the picker offers: it covers exactly the supported providers,
// an unknown provider yields an empty list, and every listed model has a price so its cost resolves.
import { describe, it, expect } from "vitest";
import {
  AVAILABLE_MODELS,
  anthropicModel,
  listModels,
  modelEffortLists,
  offeredModelIds,
  scalewayModel,
} from "./registry";
import { getRate } from "./pricing";
import { defaultEffortFor } from "./selection";
import { SUPPORTED_PROVIDERS, modelReasoningEfforts, vocabularyFor } from "@/lib/agent/buildModel";

describe("models catalog", () => {
  it("lists a provider's models from the curated catalog", () => {
    // Cheapest first, and within a tier the newer model leads; the superseded ones stay offered.
    expect(listModels("anthropic")).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-4-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-opus-5-5",
      "claude-opus-4-8",
    ]);
    // Order matters for openai too: gpt-5.1 stays the default, ahead of the cheaper Luna models.
    expect(listModels("openai")).toEqual([
      "gpt-5.1",
      "gpt-6-luna",
      "gpt-5.6-luna",
      "gpt-5",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-5.6-terra",
      "gpt-5.4",
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-6-astra",
      "gpt-5.5-pro",
    ]);
    // Order matters for deepseek: the first entry is what a bare provider choice resolves to.
    expect(listModels("deepseek")).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(listModels("moonshot")).toContain("kimi-k3");
    expect(listModels("mistral")).toEqual(["mistral-large-4"]);
    expect(listModels("scaleway")).toEqual(["deepseek-v4-flash-0731", "qwen3.6-35b-a3b"]);
  });

  it("returns an empty list for an unknown provider", () => {
    expect(listModels("not-a-provider")).toEqual([]);
  });

  // Both directions: a provider with no builder cannot run, and one with no records offers nothing.
  it("lists models for exactly the supported providers", () => {
    expect(Object.keys(AVAILABLE_MODELS).sort()).toEqual([...SUPPORTED_PROVIDERS].sort());
  });

  // Every supported provider must serve at least one model: the fallback selection is the first
  // available provider's first model, so an empty list would resolve to no model at all.
  it("offers at least one model for every supported provider", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(listModels(provider).length, `no models for ${provider}`).toBeGreaterThan(0);
    }
  });

  // The id and its levels sit on one record, so the picker's map cannot miss or invent a model.
  it("carries each offered model's effort list beside its id", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(Object.keys(modelEffortLists(provider)), provider).toEqual(listModels(provider));
      expect(vocabularyFor(provider).modelReasoningEfforts, provider).toEqual(modelEffortLists(provider));
    }
  });

  it("offers each model of the single-list providers its documented levels", () => {
    for (const model of listModels("deepseek")) {
      expect(modelReasoningEfforts("deepseek", model)).toEqual(["none", "low", "high", "max"]);
    }
    // Kimi K3 accepts low|high|max — no medium, and it always thinks, so none/minimal aren't offered.
    expect(modelReasoningEfforts("moonshot", "kimi-k3")).toEqual(["low", "high", "max"]);
    // One binary choice: off or Mistral's supported high reasoning mode.
    expect(modelReasoningEfforts("mistral", "mistral-large-4")).toEqual(["none", "high"]);
  });

  // Per Anthropic's thinking table: only Opus 5.5 cannot run without thinking.
  it.each(["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-4-8"])(
    "lets %s switch thinking off",
    (model) => {
      expect(modelReasoningEfforts("anthropic", model)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    },
  );

  it("keeps claude-opus-5-5 always thinking", () => {
    expect(modelReasoningEfforts("anthropic", "claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  // "none" with no way to send it would 400, and a way to send it that is never offered is dead.
  it("offers thinking-off on exactly the Anthropic models that say how to request it", () => {
    for (const id of listModels("anthropic")) {
      const model = anthropicModel(id)!;
      expect(model.efforts.includes("none"), id).toBe(model.thinkingOff !== undefined);
    }
  });

  it("gives an unoffered model no dial rather than a sibling's levels", () => {
    expect(modelReasoningEfforts("openai", "gpt-4o-retired")).toEqual([]);
    expect(modelReasoningEfforts("not-a-provider", "anything")).toEqual([]);
  });

  it.each([
    ["gpt-5", ["minimal", "low", "medium", "high"]],
    ["gpt-5.1", ["none", "low", "medium", "high"]],
    ["gpt-5.4", ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.5", ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.5-pro", ["medium", "high", "xhigh"]],
  ])("keeps %s on the levels its model page lists", (model, levels) => {
    expect(modelReasoningEfforts("openai", model)).toEqual(levels);
  });

  // GPT-5.5 Pro has no "low", the usual starting level, so it starts at its quietest instead.
  it("starts gpt-5.5-pro at medium", () => {
    expect(defaultEffortFor(vocabularyFor("openai"), "gpt-5.5-pro")).toBe("medium");
  });

  it.each(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-luna", "gpt-6-sol"])(
    "offers %s max, and none but not minimal",
    (model) => {
      expect(modelReasoningEfforts("openai", model)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    },
  );

  // These always reason, so there is no off position to offer.
  it.each(["gpt-6.1-sol", "gpt-6-astra"])("offers %s low…max only", (model) => {
    expect(modelReasoningEfforts("openai", model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  /**
   * Scaleway's gateway validates reasoning_effort against vLLM's whole union for every model, so an
   * unsupported level does not fail — it collapses to the model's default. Nothing but its record
   * stops the picker offering "low" and "high" on a model where both silently mean "medium".
   */
  it.each([
    ["deepseek-v4-flash-0731", ["none", "low", "high", "max"]],
    ["qwen3.6-35b-a3b", ["none", "medium"]],
  ])("keeps %s on the levels its vendor documents", (model, levels) => {
    expect(modelReasoningEfforts("scaleway", model)).toEqual(levels);
  });

  // The default has to be selectable, or the model's own resting level is unreachable.
  it("lets every Scaleway model select its own default level", () => {
    for (const id of listModels("scaleway")) {
      const model = scalewayModel(id)!;
      expect(model.efforts, `${id} cannot select its default`).toContain(model.fallbackEffort);
    }
  });

  // "none" is how a toggle stores its unchecked state (see THINKING_OFF_EFFORT), so a model that
  // reasons by default and cannot be told not to would bill for thinking nobody asked for.
  it("lets every Scaleway model switch thinking off", () => {
    for (const model of listModels("scaleway")) {
      expect(modelReasoningEfforts("scaleway", model), `${model} cannot stop reasoning`).toContain("none");
    }
  });

  it("has a resolvable price for every offered model", () => {
    for (const model of offeredModelIds()) {
      expect(getRate(model), `missing pricing for ${model}`).toBeDefined();
    }
  });

  /**
   * Reselling is the trap here: Scaleway serves DeepSeek's weights, so the app offers the same model
   * twice — once direct, once via Paris. Same weights, different vendor, different price, different
   * currency. One shared catalog key would bill one route at the other's rate, invisibly.
   */
  it("prices a resold model separately from the same model bought direct", () => {
    const direct = getRate("deepseek-v4-flash");
    const viaScaleway = getRate("deepseek-v4-flash-0731");

    expect(direct).toBeDefined();
    expect(viaScaleway).toBeDefined();
    expect(direct!.currency).toBe("USD");
    expect(viaScaleway!.currency).toBe("EUR");
    expect(viaScaleway!.input).not.toBe(direct!.input);
    expect(viaScaleway!.output).not.toBe(direct!.output);
  });

  // The ids must stay distinct, or the two rates above collapse into one catalog entry.
  it("gives every offered model a globally unique id, across providers", () => {
    const ids = offeredModelIds();
    expect(new Set(ids).size, `duplicate model id across providers: ${ids.join(", ")}`).toBe(ids.length);
  });
});
