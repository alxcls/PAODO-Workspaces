// The code-owned list of models the picker offers: it covers exactly the supported providers,
// an unknown provider yields an empty list, and every listed model has a price so its cost resolves.
import { describe, it, expect } from "vitest";
import { AVAILABLE_MODELS, listModels, offeredModelIds } from "./registry";
import { getRate } from "./pricing";
import { OPENAI_MODEL_EFFORTS } from "./openaiEfforts";
import { SCALEWAY_MODEL_EFFORTS } from "./scalewayEfforts";
import { SUPPORTED_PROVIDERS, getProviderMetadata, modelReasoningEfforts } from "@/lib/agent/buildModel";

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
    expect(listModels("openai")).toEqual([
      "gpt-6-luna",
      "gpt-5.6-luna",
      "gpt-5.1",
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
    // The levels differ per provider, and per model where a vendor documents them that way.
    expect(getProviderMetadata("anthropic").reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // OpenAI's levels belong to the model too: a union here, narrowed by modelReasoningEfforts.
    expect(getProviderMetadata("openai").reasoningEfforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getProviderMetadata("deepseek").reasoningEfforts).toEqual(["none", "low", "high", "max"]);
    // Kimi K3 accepts low|high|max — no medium, and it always thinks, so none/minimal aren't offered.
    expect(getProviderMetadata("moonshot").reasoningEfforts).toEqual(["low", "high", "max"]);
    // Medium exposes one binary choice: off or Mistral's supported high reasoning mode.
    expect(getProviderMetadata("mistral").reasoningEfforts).toEqual(["none", "high"]);
    // Scaleway's levels belong to the model, so the provider list is a union that is never offered
    // whole — modelReasoningEfforts narrows it wherever a model is in hand.
    expect(getProviderMetadata("scaleway").reasoningEfforts).toEqual(["none", "low", "medium", "high", "max"]);
  });

  // An OpenAI model with no entry would be offered the union, which no single model accepts whole.
  it("narrows every offered OpenAI model to its own levels", () => {
    for (const model of listModels("openai")) {
      expect(OPENAI_MODEL_EFFORTS[model], `${model} has no effort list`).toBeDefined();
      expect(modelReasoningEfforts("openai", model)).toEqual(OPENAI_MODEL_EFFORTS[model]);
    }
  });

  it.each(["gpt-5.1", "gpt-5", "gpt-5.4", "gpt-5.5", "gpt-5.5-pro"])("keeps %s on none…xhigh, without max", (model) => {
    expect(modelReasoningEfforts("openai", model)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
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

  it("keeps OpenAI's provider-wide list equal to the union of its models' levels", () => {
    const union = new Set(listModels("openai").flatMap((m) => [...modelReasoningEfforts("openai", m)]));
    expect(new Set(getProviderMetadata("openai").reasoningEfforts)).toEqual(union);
  });

  /**
   * Scaleway's gateway validates reasoning_effort against vLLM's whole union for every model, so an
   * unsupported level does not fail — it collapses to the model's default. Nothing but this table
   * stops the picker offering "low" and "high" on a model where both silently mean "medium".
   */
  it("narrows every offered Scaleway model to the levels its vendor documents", () => {
    for (const model of listModels("scaleway")) {
      const efforts = SCALEWAY_MODEL_EFFORTS[model];
      expect(efforts, `${model} has no documented effort list`).toBeDefined();
      expect(modelReasoningEfforts("scaleway", model)).toEqual(efforts.supported);
      // The default has to be selectable, or the model's own resting level is unreachable.
      expect(efforts.supported, `${model} cannot select its default`).toContain(efforts.fallback);
    }
  });

  // Every level the app offers on some Scaleway model, and nothing else: a union wider than the
  // per-model lists would be handed to any future model that arrives without an entry.
  it("keeps Scaleway's provider-wide list equal to the union of its models' levels", () => {
    const union = new Set(listModels("scaleway").flatMap((m) => [...modelReasoningEfforts("scaleway", m)]));
    expect(new Set(getProviderMetadata("scaleway").reasoningEfforts)).toEqual(union);
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
