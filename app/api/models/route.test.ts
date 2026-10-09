import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/operations/models/catalog", () => ({
  getModelCatalog: () => ({
    openai: { models: ["gpt-5.5"], modelReasoningEfforts: { "gpt-5.5": ["none", "low", "high"] }, hasKey: true },
    deepseek: { models: ["deepseek-v4-pro"], modelReasoningEfforts: { "deepseek-v4-pro": [] }, hasKey: false },
  }),
}));

import { GET } from "./route";

describe("GET /api/models", () => {
  it("returns one hierarchical provider catalog", async () => {
    expect(await GET().json()).toEqual({
      providers: {
        openai: {
          models: ["gpt-5.5"],
          modelReasoningEfforts: { "gpt-5.5": ["none", "low", "high"] },
          hasKey: true,
        },
        deepseek: { models: ["deepseek-v4-pro"], modelReasoningEfforts: { "deepseek-v4-pro": [] }, hasKey: false },
      },
    });
  });

  // The instance CLI token can read this route, so the whole key set is pinned: it may learn
  // whether a provider key exists and nothing else about it.
  it("discloses key presence as a boolean and nothing more about the key", async () => {
    const { providers } = (await GET().json()) as {
      providers: Record<string, Record<string, unknown>>;
    };

    for (const [provider, entry] of Object.entries(providers)) {
      expect(typeof entry.hasKey, `${provider}.hasKey`).toBe("boolean");
      expect(Object.keys(entry).sort(), provider).toEqual(["hasKey", "modelReasoningEfforts", "models"]);
    }
  });
});
