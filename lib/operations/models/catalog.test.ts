// The catalog answers two questions: what may this deployment choose, and what can it pay for.
// Conflating them served a keyless deployment an empty picker, the only place a key can be entered.
import { describe, expect, it } from "vitest";
import { getModelCatalog } from "./catalog";
import { SUPPORTED_PROVIDERS, providerAvailabilityEnv } from "@/lib/agent/buildModel";

/** Switch off every provider except the named ones, so a case can assert on an exact catalog. */
const only = (...providers: string[]) =>
  Object.fromEntries(providers.map((p) => [providerAvailabilityEnv(p)!, "true"]));

// Key state is injected rather than written to the encrypted store on disk: what this module does
// with the answer is the thing under test, not how the answer is stored.
const keyed =
  (...providers: string[]) =>
  (provider: string) =>
    providers.includes(provider);
const noKeys = () => false;

describe("model catalog", () => {
  it("keeps each offered provider beside its models and each model's reasoning efforts", () => {
    const switchable = ["none", "low", "medium", "high", "xhigh", "max"];
    const deepseekLevels = ["none", "low", "high", "max"];
    expect(getModelCatalog(only("anthropic", "deepseek"), keyed("anthropic", "deepseek"))).toEqual({
      anthropic: {
        models: [
          "claude-haiku-5-5",
          "claude-haiku-4-5",
          "claude-sonnet-5-5",
          "claude-sonnet-5",
          "claude-opus-5-5",
          "claude-opus-4-8",
        ],
        modelReasoningEfforts: {
          "claude-haiku-5-5": switchable,
          "claude-haiku-4-5": switchable,
          "claude-sonnet-5-5": switchable,
          "claude-sonnet-5": switchable,
          "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
          "claude-opus-4-8": switchable,
        },
        hasKey: true,
      },
      deepseek: {
        models: ["deepseek-flash", "deepseek-v4-pro"],
        modelReasoningEfforts: { "deepseek-flash": deepseekLevels, "deepseek-v4-pro": deepseekLevels },
        hasKey: true,
      },
    });
  });

  // The dead end this replaces: only keyed providers were published, so a keyless deployment got
  // `{}`, an empty picker on the page whose settings modal is the only way to enter a key.
  it("publishes every offered provider, with its models, when no key is set anywhere", () => {
    const catalog = getModelCatalog(only(...SUPPORTED_PROVIDERS), noKeys);
    expect(Object.keys(catalog)).toEqual(SUPPORTED_PROVIDERS);
    expect(catalog.anthropic.models.length).toBeGreaterThan(0);
  });

  it("reports which providers can authenticate without saying anything else about the key", () => {
    const catalog = getModelCatalog(only("anthropic", "deepseek"), keyed("deepseek"));
    expect(catalog.anthropic.hasKey).toBe(false);
    expect(catalog.deepseek.hasKey).toBe(true);
  });

  // This response is readable by the instance CLI token, which may learn that a provider cannot
  // authenticate but nothing about the key. The masked hint lives on a route the CLI cannot reach.
  it("carries no key material — only the boolean", () => {
    const catalog = getModelCatalog(only("deepseek"), keyed("deepseek"));
    expect(Object.keys(catalog.deepseek).sort()).toEqual(["hasKey", "modelReasoningEfforts", "models"]);
  });

  // The picker reads this map and nothing else, so a model missing from it would lose its dial.
  it("publishes an effort list for every model of every provider", () => {
    const catalog = getModelCatalog(only(...SUPPORTED_PROVIDERS), noKeys);
    for (const [provider, entry] of Object.entries(catalog)) {
      expect(Object.keys(entry.modelReasoningEfforts).sort(), provider).toEqual([...entry.models].sort());
    }
    expect(catalog.openai.modelReasoningEfforts["gpt-6.1-sol"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("omits a provider .env switched off, models and all", () => {
    // A disabled provider's models never reach the picker, and its stored key was destroyed at
    // startup, so a workspace that selected it earlier cannot run it either.
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
