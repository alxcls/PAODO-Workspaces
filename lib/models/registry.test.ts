// The model catalog is a code-owned list of the models offered in the picker. What matters: it
// covers exactly the supported providers, listModels reflects it, an unknown provider yields an
// empty list, and every listed model has a matching pricing entry so its usage cost resolves.
import { describe, it, expect } from "vitest";
import { AVAILABLE_MODELS, listModels, offeredModelIds } from "./registry";
import { getRate } from "./pricing";
import { SCALEWAY_MODEL_EFFORTS } from "./scalewayEfforts";
import { SUPPORTED_PROVIDERS, getProviderMetadata, modelReasoningEfforts } from "@/lib/agent/buildModel";

describe("models catalog", () => {
  it("lists a provider's models from the curated catalog", () => {
    expect(listModels("anthropic")).toContain("claude-opus-4-8");
    // Order matters for deepseek: the first entry is what a bare provider choice resolves to.
    expect(listModels("deepseek")).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(listModels("moonshot")).toContain("kimi-k3");
    expect(listModels("mistral")).toEqual(["codestral-latest", "mistral-large-latest", "mistral-medium-latest"]);
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
    expect(getProviderMetadata("deepseek").reasoningEfforts).toEqual(["none", "low", "high", "max"]);
    // Kimi K3 accepts low|high|max — no medium, and it always thinks, so none/minimal aren't offered.
    expect(getProviderMetadata("moonshot").reasoningEfforts).toEqual(["low", "high", "max"]);
    // Medium exposes one binary choice: off or Mistral's supported high reasoning mode.
    expect(getProviderMetadata("mistral").reasoningEfforts).toEqual(["none", "high"]);
    // Scaleway's levels belong to the model, so the provider list is a union that is never offered
    // whole — modelReasoningEfforts narrows it wherever a model is in hand.
    expect(getProviderMetadata("scaleway").reasoningEfforts).toEqual(["none", "low", "medium", "high", "max"]);
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
