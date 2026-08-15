import { describe, expect, it } from "vitest";
import { getModelCatalog } from "./catalog";

describe("model catalog", () => {
  it("keeps each configured provider beside its models and reasoning efforts", () => {
    expect(
      getModelCatalog({
        ANTHROPIC_API_KEY: "configured",
        DEEPSEEK_API_KEY: "configured",
      }),
    ).toEqual({
      anthropic: {
        models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"],
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        // Every model in `models` carries a thinking entry, so the picker never has to guess a
        // default for one of them. Anthropic's are all "always": buildModel sends a thinking config
        // on every request, so the checkbox shows checked and disabled rather than pretending the
        // user could turn it off.
        thinking: {
          "claude-haiku-4-5": "always",
          "claude-sonnet-5": "always",
          "claude-opus-4-8": "always",
        },
      },
      deepseek: {
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        reasoningEfforts: [],
        thinking: { "deepseek-v4-flash": "never", "deepseek-v4-pro": "never" },
      },
    });
  });

  // Mistral is why thinking is per-model: one provider id serving a model that toggles, a model that
  // always thinks and rejects the switch, and models with no thinking mode at all.
  it("describes thinking per model, not per provider", () => {
    const { mistral } = getModelCatalog({ MISTRAL_API_KEY: "configured" });
    expect(mistral.thinking["mistral-small-2603"]).toBe("toggle");
    expect(mistral.thinking["magistral-medium-latest"]).toBe("always");
    expect(mistral.thinking["codestral-2508"]).toBe("never");
    // Nothing may be missing an entry — an absent key would silently read as "never" in the picker
    // and hide a control the model genuinely offers.
    for (const model of mistral.models) expect(mistral.thinking[model], `no thinking for ${model}`).toBeDefined();
  });

  it("omits providers the app cannot authenticate", () => {
    expect(getModelCatalog({})).toEqual({});
  });

  it("omits a keyed provider that .env switched off, models and all", () => {
    // The switch is what makes the choosable set deployment-configurable: a disabled provider's models
    // never reach the picker, so they cannot be selected there.
    const catalog = getModelCatalog({
      ANTHROPIC_API_KEY: "configured",
      DEEPSEEK_API_KEY: "configured",
      ANTHROPIC_AVAILABLE: "false",
    });
    expect(Object.keys(catalog)).toEqual(["deepseek"]);
  });
});
