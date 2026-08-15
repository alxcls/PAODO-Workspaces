// The catalog answers two questions that used to be one: what may this deployment choose, and what
// can it currently pay for. Conflating them is what made a keyless deployment serve an empty picker
// — and since keys are only enterable through that picker's own settings modal, an empty one is a
// dead end nobody can escape.
import { describe, expect, it } from "vitest";
import { getModelCatalog } from "./catalog";
import { SUPPORTED_PROVIDERS, providerAvailabilityEnv } from "@/lib/agent/buildModel";

/** Switch off every provider except the named ones, so a case can assert on an exact catalog. */
const only = (...providers: string[]) =>
  Object.fromEntries(
    SUPPORTED_PROVIDERS.filter((p) => !providers.includes(p)).map((p) => [providerAvailabilityEnv(p)!, "false"]),
  );

// Key state is injected rather than written to the encrypted store on disk: what this module does
// with the answer is the thing under test, not how the answer is stored.
const keyed =
  (...providers: string[]) =>
  (provider: string) =>
    providers.includes(provider);
const noKeys = () => false;

describe("model catalog", () => {
  it("keeps each offered provider beside its models and reasoning efforts", () => {
    expect(getModelCatalog(only("anthropic", "deepseek"), keyed("anthropic", "deepseek"))).toEqual({
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
        hasKey: true,
      },
      deepseek: {
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        reasoningEfforts: [],
        thinking: { "deepseek-v4-flash": "never", "deepseek-v4-pro": "never" },
        hasKey: true,
      },
    });
  });

  // Mistral is why thinking is per-model: one provider id serving a model that toggles, a model that
  // always thinks and rejects the switch, and models with no thinking mode at all.
  it("describes thinking per model, not per provider", () => {
    const { mistral } = getModelCatalog(only("mistral"), keyed("mistral"));
    expect(mistral.thinking["mistral-small-2603"]).toBe("toggle");
    expect(mistral.thinking["magistral-medium-latest"]).toBe("always");
    expect(mistral.thinking["codestral-2508"]).toBe("never");
    // Nothing may be missing an entry — an absent key would silently read as "never" in the picker
    // and hide a control the model genuinely offers.
    for (const model of mistral.models) expect(mistral.thinking[model], `no thinking for ${model}`).toBeDefined();
  });

  // The dead end this replaces: the catalog used to publish only keyed providers, so a deployment
  // with no keys served `{}` — an empty picker, on the page whose settings modal is the only way to
  // enter a key.
  it("publishes every offered provider, with its models, when no key is set anywhere", () => {
    const catalog = getModelCatalog({}, noKeys);
    expect(Object.keys(catalog)).toEqual(SUPPORTED_PROVIDERS);
    expect(catalog.anthropic.models.length).toBeGreaterThan(0);
  });

  it("reports which providers can authenticate without saying anything else about the key", () => {
    const catalog = getModelCatalog(only("anthropic", "deepseek"), keyed("deepseek"));
    expect(catalog.anthropic.hasKey).toBe(false);
    expect(catalog.deepseek.hasKey).toBe(true);
  });

  // Load-bearing for a decision, not just a shape: this response is readable by the instance CLI
  // token, which may learn that a provider cannot authenticate but nothing about the key itself. The
  // masked hint and set-date live on GET /api/settings/provider-keys, which the CLI cannot reach.
  it("carries no key material — only the boolean", () => {
    const catalog = getModelCatalog(only("deepseek"), keyed("deepseek"));
    expect(Object.keys(catalog.deepseek).sort()).toEqual(["hasKey", "models", "reasoningEfforts", "thinking"]);
  });

  it("omits a provider .env switched off, models and all", () => {
    // The switch is what makes the choosable set deployment-configurable: a disabled provider's models
    // never reach the picker, so they cannot be selected there — and its stored key was destroyed at
    // startup, so it cannot be run by a workspace that selected it earlier either.
    const catalog = getModelCatalog(only("anthropic", "deepseek"), keyed("anthropic", "deepseek"));
    expect(Object.keys(catalog)).toEqual(["anthropic", "deepseek"]);
    expect(Object.keys(getModelCatalog({ ...only("anthropic", "deepseek"), ANTHROPIC_AVAILABLE: "false" }))).toEqual([
      "deepseek",
    ]);
  });

  it("serves nothing when every provider is switched off", () => {
    const allOff = Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [providerAvailabilityEnv(p)!, "false"]));
    expect(getModelCatalog(allOff, noKeys)).toEqual({});
  });
});
