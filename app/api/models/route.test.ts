import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/operations/models/catalog", () => ({
  getModelCatalog: () => ({
    openai: { models: ["gpt-5.5"], reasoningEfforts: ["none", "low", "high"] },
    deepseek: { models: ["deepseek-v4-pro"], reasoningEfforts: [] },
  }),
}));

import { GET } from "./route";

describe("GET /api/models", () => {
  it("returns one hierarchical provider catalog", async () => {
    expect(await GET().json()).toEqual({
      providers: {
        openai: { models: ["gpt-5.5"], reasoningEfforts: ["none", "low", "high"] },
        deepseek: { models: ["deepseek-v4-pro"], reasoningEfforts: [] },
      },
    });
  });
});
