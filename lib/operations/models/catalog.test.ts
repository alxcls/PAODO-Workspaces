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
        models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
      deepseek: {
        models: ["deepseek-v4-pro"],
        reasoningEfforts: [],
      },
    });
  });

  it("omits providers the app cannot authenticate", () => {
    expect(getModelCatalog({})).toEqual({});
  });
});
