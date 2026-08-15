import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/operations/models/catalog", () => ({
  getModelCatalog: () => ({
    openai: { models: ["gpt-5.5"], reasoningEfforts: ["none", "low", "high"], thinking: {}, hasKey: true },
    deepseek: { models: ["deepseek-v4-pro"], reasoningEfforts: [], thinking: {}, hasKey: false },
  }),
}));

import { GET } from "./route";

describe("GET /api/models", () => {
  it("returns one hierarchical provider catalog", async () => {
    expect(await GET().json()).toEqual({
      providers: {
        openai: { models: ["gpt-5.5"], reasoningEfforts: ["none", "low", "high"], thinking: {}, hasKey: true },
        deepseek: { models: ["deepseek-v4-pro"], reasoningEfforts: [], thinking: {}, hasKey: false },
      },
    });
  });

  // This route is on the instance CLI token's allowlist, so its response is the exact boundary of
  // what that token may learn about provider keys: whether one exists, and nothing else. The masked
  // hint and the set-date live on /api/settings/provider-keys, which the token cannot reach at all
  // (platformAccessPolicy.test.ts pins that half). Widening this shape re-opens the decision by
  // accident, which is why the assertion is on the whole key set rather than on named fields.
  it("discloses key presence as a boolean and nothing more about the key", async () => {
    const { providers } = (await GET().json()) as {
      providers: Record<string, Record<string, unknown>>;
    };

    for (const [provider, entry] of Object.entries(providers)) {
      expect(typeof entry.hasKey, `${provider}.hasKey`).toBe("boolean");
      expect(Object.keys(entry).sort(), provider).toEqual(["hasKey", "models", "reasoningEfforts", "thinking"]);
    }
  });
});
