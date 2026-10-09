// The defaulting rules both surfaces resolve with. Tested directly, not only through the update
// path, because the picker calls these primitives on their own.
import { describe, it, expect } from "vitest";
import {
  defaultEffortFor,
  defaultModelFor,
  effortsForModel,
  firstAvailableSelection,
  resolveModelSelection,
} from "./selection";
import type { ModelVocabulary } from "./selection";

const OPENAI_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const OPENAI: ModelVocabulary = {
  models: ["gpt-5.5", "gpt-5.4"],
  modelReasoningEfforts: { "gpt-5.5": OPENAI_LEVELS, "gpt-5.4": OPENAI_LEVELS },
};
const MOONSHOT: ModelVocabulary = {
  models: ["kimi-k3"],
  modelReasoningEfforts: { "kimi-k3": ["low", "high", "max"] },
};
const DEEPSEEK: ModelVocabulary = {
  models: ["deepseek-v4-pro"],
  modelReasoningEfforts: { "deepseek-v4-pro": [] },
};

// One provider whose models disagree: "narrow" takes two levels, "wide" four, "dialless" none.
const NARROWING: ModelVocabulary = {
  models: ["narrow", "wide", "dialless"],
  modelReasoningEfforts: { narrow: ["none", "medium"], wide: ["none", "low", "medium", "high"], dialless: [] },
};

const NOTHING: ModelVocabulary = { models: [], modelReasoningEfforts: {} };
const single = (...efforts: ModelVocabulary["modelReasoningEfforts"][string]): ModelVocabulary => ({
  models: ["m"],
  modelReasoningEfforts: { m: efforts },
});

const VOCABULARIES: Record<string, ModelVocabulary> = {
  openai: OPENAI,
  moonshot: MOONSHOT,
  deepseek: DEEPSEEK,
  narrowing: NARROWING,
};
const lookup = (provider: string): ModelVocabulary => VOCABULARIES[provider] ?? NOTHING;

const CURRENT = { provider: "openai", model: "gpt-5.4", reasoningEffort: "medium" as const };

describe("defaultModelFor", () => {
  it("takes the catalog's first entry, which is ordered default-first", () => {
    expect(defaultModelFor(OPENAI)).toBe("gpt-5.5");
  });

  it("returns empty for a provider serving no models rather than guessing", () => {
    expect(defaultModelFor(NOTHING)).toBe("");
  });
});

describe("defaultEffortFor", () => {
  it("uses low wherever the model offers it", () => {
    expect(defaultEffortFor(MOONSHOT, "kimi-k3")).toBe("low");
    expect(defaultEffortFor(OPENAI, "gpt-5.5")).toBe("low");
  });

  // Guards the fallback itself: "low" is a preference, not an assumption about every model.
  it("falls back to the quietest offered level when low is absent", () => {
    expect(defaultEffortFor(single("medium", "xhigh"), "m")).toBe("medium");
  });

  // "none" turns reasoning off entirely, so first-in-the-list is not a safe rule on its own.
  it("skips none rather than defaulting a model to no reasoning at all", () => {
    expect(defaultEffortFor(single("none", "medium"), "m")).toBe("medium");
  });

  it("defaults to the model's own levels, not a sibling's", () => {
    expect(defaultEffortFor(NARROWING, "narrow")).toBe("medium");
    expect(defaultEffortFor(NARROWING, "wide")).toBe("low");
  });
});

// Levels belong to the model: reading a sibling's list is what would offer a level that the chosen
// model rejects, or that silently collapses to something else.
describe("effortsForModel", () => {
  it("returns each model its own list", () => {
    expect(effortsForModel(NARROWING, "narrow")).toEqual(["none", "medium"]);
    expect(effortsForModel(NARROWING, "wide")).toEqual(["none", "low", "medium", "high"]);
  });

  // A retired id a workspace still stores: no dial, rather than some other model's levels.
  it("gives a model with no entry no dial", () => {
    expect(effortsForModel(NARROWING, "retired")).toEqual([]);
  });

  it.each(["constructor", "__proto__", "hasOwnProperty"])(
    "treats the inherited property %s as absent rather than as a model entry",
    (model) => {
      expect(effortsForModel(NARROWING, model)).toEqual([]);
    },
  );

  it("treats an empty list as no dial", () => {
    expect(effortsForModel(NARROWING, "dialless")).toEqual([]);
  });
});

// The rule on its own, fed vocabularies directly: the edges an env-driven test cannot reach, such
// as an empty list and a provider serving no models. Availability is tested with buildModel.
describe("firstAvailableSelection", () => {
  const vocabularies: Record<string, ModelVocabulary> = {
    first: {
      models: ["first-a", "first-b"],
      modelReasoningEfforts: { "first-a": ["low", "high"], "first-b": ["low", "high"] },
    },
    second: { models: ["second-a"], modelReasoningEfforts: { "second-a": [] } },
    barren: NOTHING,
  };
  const lookup = (provider: string) => vocabularies[provider] ?? NOTHING;

  it("takes the first provider offered, ignoring the rest", () => {
    expect(firstAvailableSelection(["first", "second"], lookup)).toEqual({
      provider: "first",
      model: "first-a",
      reasoningEffort: "low",
    });
  });

  it("stores the uniform placeholder for a model with no effort dial", () => {
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

  // Switching between two models of the SAME provider changes the accepted levels, so the reset
  // has to consult the incoming model.
  it("resets effort to the incoming model's default", () => {
    const current = { provider: "narrowing", model: "wide", reasoningEffort: "high" as const };
    expect(resolveModelSelection({ model: "narrow" }, current, lookup).reasoningEffort).toBe("medium");
  });

  it("resolves a model with no dial to the placeholder, beside siblings that have one", () => {
    const current = { provider: "narrowing", model: "wide", reasoningEffort: "high" as const };
    expect(resolveModelSelection({ model: "dialless" }, current, lookup)).toEqual({
      provider: "narrowing",
      model: "dialless",
      reasoningEffort: "low",
    });
  });
});
