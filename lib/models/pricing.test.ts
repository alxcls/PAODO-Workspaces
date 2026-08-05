// The pricing module is a thin lookup over the vendored catalog. What matters: rates resolve for
// known models (both bare and provider-prefixed ids), cost math doesn't double-charge cached input,
// and unknown models yield undefined (so the UI shows "—" not a fake $0).
import { describe, it, expect } from "vitest";
import { getRate, computeCost } from "./pricing";

describe("modelPricing", () => {
  it("resolves a rate for a catalog model", () => {
    const rate = getRate("deepseek-v4-pro");
    expect(rate).toBeDefined();
    expect(rate!.input).toBeGreaterThan(0);
    expect(rate!.output).toBeGreaterThan(0);
  });

  it("resolves provider-prefixed ids via the bare tail", () => {
    expect(getRate("deepseek/deepseek-v4-pro")).toEqual(getRate("deepseek-v4-pro"));
  });

  it("returns undefined for unknown or missing models", () => {
    expect(getRate("not-a-real-model")).toBeUndefined();
    expect(getRate(undefined)).toBeUndefined();
    expect(
      computeCost(
        {
          inputTokensTotal: 100,
          inputTokensCacheRead: 0,
          inputTokensCacheWrite: 0,
          outputTokensTotal: 100,
        },
        "not-a-real-model",
      ),
    ).toBeUndefined();
  });

  // llmModel is free-form on the workspace PATCH route, so these ids are reachable by an
  // authenticated user. Indexing the catalog directly would hand back an inherited member — truthy,
  // so getRate would report a rate whose fields are all undefined and computeCost would return NaN.
  // A single NaN turn poisons the whole session total, since usageSessions.ts sums per-turn costs.
  it.each(["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"])(
    "treats the inherited property %s as an unknown model, not a rate",
    (modelId) => {
      expect(getRate(modelId)).toBeUndefined();
      expect(
        computeCost(
          {
            inputTokensTotal: 100,
            inputTokensCacheRead: 0,
            inputTokensCacheWrite: 0,
            outputTokensTotal: 100,
          },
          modelId,
        ),
      ).toBeUndefined();
    },
  );

  it("computes cost without double-charging cached input", () => {
    const rate = getRate("deepseek-v4-pro")!;
    // 1000 input of which 400 cached, 500 output, no cache-creation.
    const tokens = {
      inputTokensTotal: 1000,
      inputTokensCacheRead: 400,
      inputTokensCacheWrite: 0,
      outputTokensTotal: 500,
    };
    const expected = 600 * rate.input + 400 * rate.cachedInput + 500 * rate.output;
    expect(computeCost(tokens, "deepseek-v4-pro")).toBeCloseTo(expected, 12);
  });

  it("does not double-charge Anthropic cache-creation tokens folded into input_tokens", () => {
    const rate = getRate("claude-opus-4-8")!;
    // Providers report input_tokens as the total: here 1000 = 600 base + 300 cache_read + 100
    // cache_creation. Only the 600 base should pay the plain input rate; the other buckets pay their
    // own rates. Without subtracting cache-creation, the 100 creation tokens would be billed twice.
    const tokens = {
      inputTokensTotal: 1000,
      inputTokensCacheRead: 300,
      inputTokensCacheWrite: 100,
      outputTokensTotal: 500,
    };
    const expected = 600 * rate.input + 300 * rate.cachedInput + 100 * rate.cacheCreation + 500 * rate.output;
    expect(computeCost(tokens, "claude-opus-4-8")).toBeCloseTo(expected, 12);
  });
});
