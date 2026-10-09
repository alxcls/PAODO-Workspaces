// Rates resolve for bare and provider-prefixed ids, cached input is never double-charged, and an unknown model
// yields undefined so the UI shows "—", not a fake $0.
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

  // llmModel is free-form, so these ids are reachable; an inherited member would price a turn at NaN and
  // poison the whole session total lib/usage/sessions.ts sums.
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

  // Haiku 5.5 bills the WHOLE request on a dearer card once its prompt passes 100K tokens, and the
  // prompt is every input token, cache reads included. One flat rate would understate it fivefold.
  it("switches to the long-prompt rate card once the prompt passes its threshold", () => {
    const base = getRate("claude-haiku-5-5")!;
    const long = getRate("claude-haiku-5-5", 100_001)!;
    expect(getRate("claude-haiku-5-5", 100_000)).toEqual(base);
    expect(long.input).toBeCloseTo(base.input * 5, 12);
    expect(long.output).toBeCloseTo(base.output * 5, 12);
    expect(long.cachedInput).toBeCloseTo(base.cachedInput * 5, 12);

    const tokens = {
      inputTokensTotal: 150_000,
      inputTokensCacheRead: 120_000,
      inputTokensCacheWrite: 0,
      outputTokensTotal: 1_000,
    };
    const expected = 30_000 * long.input + 120_000 * long.cachedInput + 1_000 * long.output;
    expect(computeCost(tokens, "claude-haiku-5-5")).toBeCloseTo(expected, 12);
  });

  it("keeps a model without a long-prompt card on one rate at any prompt length", () => {
    expect(getRate("claude-opus-5-5", 900_000)).toEqual(getRate("claude-opus-5-5"));
  });

  it("prices Mistral cache reads at 10% of normal input", () => {
    const rate = getRate("mistral-large-4")!;
    expect(rate.cachedInput).toBeCloseTo(rate.input * 0.1, 12);
  });

  it("does not double-charge Anthropic cache-creation tokens folded into input_tokens", () => {
    const rate = getRate("claude-opus-4-8")!;
    // input_tokens is the total: 1000 = 600 base + 300 cache_read + 100 cache_creation. Only the base pays the
    // plain input rate; without subtracting cache-creation, those 100 tokens would be billed twice.
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
