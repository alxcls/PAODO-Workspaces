// The defaulting rules both surfaces resolve with. Tested directly, not only through the update path,
// because the picker calls the two primitives on their own — a change that suits the server but breaks
// carryOverEffort in isolation would otherwise only surface in the UI.
import { describe, it, expect } from "vitest";
import { defaultEffortFor, defaultModelFor, firstAvailableSelection, resolveModelSelection } from "./selection";
import type { ModelVocabulary } from "./selection";

const OPENAI: ModelVocabulary = {
  models: ["gpt-5.5", "gpt-5.4"],
  reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
};
const MOONSHOT: ModelVocabulary = { models: ["kimi-k3"], reasoningEfforts: ["low", "high", "max"] };
const DEEPSEEK: ModelVocabulary = { models: ["deepseek-v4-pro"], reasoningEfforts: [] };

const VOCABULARIES: Record<string, ModelVocabulary> = {
  openai: OPENAI,
  moonshot: MOONSHOT,
  deepseek: DEEPSEEK,
};
const lookup = (provider: string): ModelVocabulary => VOCABULARIES[provider] ?? { models: [], reasoningEfforts: [] };

const CURRENT = { provider: "openai", model: "gpt-5.4", reasoningEffort: "medium" as const };

describe("defaultModelFor", () => {
  it("takes the catalog's first entry, which is ordered default-first", () => {
    expect(defaultModelFor(OPENAI)).toBe("gpt-5.5");
  });

  it("returns empty for a provider serving no models rather than guessing", () => {
    expect(defaultModelFor({ models: [], reasoningEfforts: [] })).toBe("");
  });
});

describe("defaultEffortFor", () => {
  it("uses low, which every provider with a dial offers", () => {
    expect(defaultEffortFor(MOONSHOT)).toBe("low");
    expect(defaultEffortFor(OPENAI)).toBe("low");
  });

  // Guards the fallback itself: "low" is a preference, not an assumption about every provider.
  it("falls back to the quietest offered level when low is absent", () => {
    expect(defaultEffortFor({ models: [], reasoningEfforts: ["medium", "xhigh"] })).toBe("medium");
  });

  // "none" turns reasoning off entirely, so first-in-the-list is not a safe rule on its own.
  it("skips none rather than defaulting a provider to no reasoning at all", () => {
    expect(defaultEffortFor({ models: [], reasoningEfforts: ["none", "medium"] })).toBe("medium");
  });
});

// The rule on its own, fed vocabularies directly. What .env makes available is buildModel's job
// (defaultModelSelection), tested there against the real registry; these pin the edges that an
// env-driven test cannot reach — an empty list, and a provider serving no models.
describe("firstAvailableSelection", () => {
  const vocabularies: Record<string, ModelVocabulary> = {
    first: { models: ["first-a", "first-b"], reasoningEfforts: ["low", "high"] },
    second: { models: ["second-a"], reasoningEfforts: [] },
    barren: { models: [], reasoningEfforts: [] },
  };
  const lookup = (provider: string) => vocabularies[provider] ?? { models: [], reasoningEfforts: [] };

  it("takes the first provider offered, ignoring the rest", () => {
    expect(firstAvailableSelection(["first", "second"], lookup)).toEqual({
      provider: "first",
      model: "first-a",
      reasoningEffort: "low",
    });
  });

  it("stores the uniform placeholder for a provider with no effort dial", () => {
    // defaultEffortFor has nothing to return from an empty list, so the guard is not decoration.
    expect(firstAvailableSelection(["second"], lookup)).toEqual({
      provider: "second",
      model: "second-a",
      reasoningEffort: "low",
    });
  });

  it("returns empty fields when nothing is available", () => {
    expect(firstAvailableSelection([], lookup)).toEqual({ provider: "", model: "", reasoningEffort: "low" });
  });

  // Not reachable today — registry.test.ts asserts every provider serves a model — but the caller
  // stores whatever comes back, so an empty model must not become an undefined one.
  it("reports an empty model rather than undefined for a provider serving none", () => {
    expect(firstAvailableSelection(["barren"], lookup)).toEqual({
      provider: "barren",
      model: "",
      reasoningEffort: "low",
    });
  });
});

describe("resolveModelSelection", () => {
  it("returns the current selection unchanged for an empty request", () => {
    expect(resolveModelSelection({}, CURRENT, lookup)).toEqual(CURRENT);
  });

  // A provider switch resets both: the model belongs to the provider being left behind, and reusing the
  // effort level would risk a value the new provider rejects at call time.
  it("resets the model and the effort on a provider switch", () => {
    expect(resolveModelSelection({ provider: "moonshot" }, CURRENT, lookup)).toEqual({
      provider: "moonshot",
      model: "kimi-k3",
      reasoningEffort: "low",
    });
    // Reset even when the new provider would have accepted the old level — one rule, no per-pair check.
    expect(
      resolveModelSelection({ provider: "moonshot" }, { ...CURRENT, reasoningEffort: "high" }, lookup).reasoningEffort,
    ).toBe("low");
  });

  // Staying on the provider must not re-pick the model, or naming an effort would move the model too.
  it("keeps the current model when the provider is unchanged", () => {
    expect(resolveModelSelection({ reasoningEffort: "xhigh" }, CURRENT, lookup)).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
    });
  });

  it("resets effort when the model changes unless an effort is explicit", () => {
    expect(resolveModelSelection({ model: "gpt-5.5" }, CURRENT, lookup).reasoningEffort).toBe("low");
    expect(resolveModelSelection({ model: "gpt-5.5", reasoningEffort: "high" }, CURRENT, lookup).reasoningEffort).toBe(
      "high",
    );
  });

  it("honors an explicit model on a provider switch instead of the catalog default", () => {
    expect(resolveModelSelection({ provider: "openai", model: "gpt-5.4" }, CURRENT, lookup).model).toBe("gpt-5.4");
  });

  // Blank is treated as absent here; refusing it is the caller's job, since only it can raise the error.
  it("treats a blank field as omitted", () => {
    expect(resolveModelSelection({ provider: "  ", model: "" }, CURRENT, lookup)).toEqual(CURRENT);
  });

  // The placeholder is all this function reports for a no-dial provider. An effort the caller actually
  // supplied is refused by validateMetadata, which owns the error — see workspaces.test.ts.
  it("resolves a no-dial provider to the placeholder effort", () => {
    expect(resolveModelSelection({ provider: "deepseek" }, CURRENT, lookup)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "low",
    });
  });
});
