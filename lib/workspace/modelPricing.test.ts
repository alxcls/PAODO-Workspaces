// The pricing module is a thin lookup over the vendored catalog. What matters: rates resolve for
// known models (both bare and provider-prefixed ids), cost math doesn't double-charge cached input,
// and unknown models yield undefined (so the UI shows "—" not a fake $0).
import { describe, it, expect } from "vitest";
import { getRate, computeCost } from "./modelPricing";

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
    expect(computeCost({ inputTokens: 100, outputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 0 }, "not-a-real-model")).toBeUndefined();
  });

  it("computes cost without double-charging cached input", () => {
    const rate = getRate("deepseek-v4-pro")!;
    // 1000 input of which 400 cached, 500 output, no cache-creation.
    const tokens = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 400, cacheCreationTokens: 0 };
    const expected = 600 * rate.input + 400 * rate.cachedInput + 500 * rate.output;
    expect(computeCost(tokens, "deepseek-v4-pro")).toBeCloseTo(expected, 12);
  });

  it("does not double-charge Anthropic cache-creation tokens folded into input_tokens", () => {
    const rate = getRate("claude-opus-4-8")!;
    // Providers report input_tokens as the total: here 1000 = 600 base + 300 cache_read + 100
    // cache_creation. Only the 600 base should pay the plain input rate; the other buckets pay their
    // own rates. Without subtracting cache-creation, the 100 creation tokens would be billed twice.
    const tokens = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 300, cacheCreationTokens: 100 };
    const expected =
      600 * rate.input + 300 * rate.cachedInput + 100 * rate.cacheCreation + 500 * rate.output;
    expect(computeCost(tokens, "claude-opus-4-8")).toBeCloseTo(expected, 12);
  });
});
