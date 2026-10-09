import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCatalog, fillGaps, fromLiteLLM, fromScalewayCatalog, scalewayEffortDrift } from "./refresh";

afterEach(() => vi.unstubAllGlobals());

describe("model price refresh", () => {
  it("vendors a prefixed Mistral row under the bare id the app looks up", () => {
    const catalog = fromLiteLLM({
      "mistral/mistral-large-4": {
        litellm_provider: "mistral",
        input_cost_per_token: 0.68 / 1e6,
        output_cost_per_token: 2.09 / 1e6,
      },
    });

    expect(catalog["mistral-large-4"]).toMatchObject({
      input_cost_per_token: 0.68 / 1e6,
      output_cost_per_token: 2.09 / 1e6,
    });
  });

  // The threshold exists only in LiteLLM's key names, and batch keys share the suffix.
  it("vendors a long-prompt rate card from LiteLLM's tiered keys", () => {
    const catalog = fromLiteLLM({
      "claude-haiku-5-5": {
        litellm_provider: "anthropic",
        input_cost_per_token: 1e-7,
        output_cost_per_token: 5e-7,
        input_cost_per_token_above_100k_tokens: 5e-7,
        output_cost_per_token_above_100k_tokens: 2.5e-6,
        cache_read_input_token_cost_above_100k_tokens: 5e-8,
        input_cost_per_token_above_100k_tokens_batches: 2.5e-7,
      },
    });

    expect(catalog["claude-haiku-5-5"].long_prompt).toEqual({
      above_tokens: 100_000,
      input_cost_per_token: 5e-7,
      output_cost_per_token: 2.5e-6,
      cache_read_input_token_cost: 5e-8,
    });
  });

  it("drops a tier priced on input alone rather than billing long completions at the base rate", () => {
    const catalog = fromLiteLLM({
      "claude-haiku-5-5": {
        litellm_provider: "anthropic",
        input_cost_per_token: 1e-7,
        output_cost_per_token: 5e-7,
        input_cost_per_token_above_100k_tokens: 5e-7,
      },
    });

    expect(catalog["claude-haiku-5-5"]).not.toHaveProperty("long_prompt");
  });

  it("vendors the same rate card from models.dev, converting from per-million", () => {
    const catalog = {};
    const cost = {
      input: 0.1,
      output: 0.5,
      tiers: [{ input: 0.5, output: 2.5, cache_read: 0.05, tier: { type: "context", size: 100_000 } }],
    };

    fillGaps(catalog, { anthropic: { models: { "claude-haiku-5-5": { cost } } } });

    expect(catalog).toMatchObject({
      "claude-haiku-5-5": {
        long_prompt: {
          above_tokens: 100_000,
          input_cost_per_token: 0.5 / 1e6,
          output_cost_per_token: 2.5 / 1e6,
          cache_read_input_token_cost: 0.05 / 1e6,
        },
      },
    });
  });
});

// Scaleway's own catalog. Rows are one metric each, so the risk is assembling the wrong metric into
// the wrong field — and the currency must survive, because nothing downstream converts it.
describe("Scaleway product catalog", () => {
  const row = (sku: string, euros: number, product = "qwen3.6-35b-a3b") => ({
    sku: `/ai/generative_apis/consumption/${sku}/fr-par`,
    product,
    product_category: "Generative APIs",
    locality: { region: "fr-par" },
    unit_of_measure: { unit: "token", size: 1000 },
    price: { retail_price: { currency_code: "EUR", units: 0, nanos: euros * 1e9 } },
  });

  it("assembles a model's metrics from its separate rows, in euros", () => {
    const catalog = fromScalewayCatalog([
      row("deepseek_v4_flash_input", 0.0004, "deepseek-v4-flash-0731"),
      row("deepseek_v4_flash_output", 0.0008, "deepseek-v4-flash-0731"),
      row("deepseek_v4_flash_input_cached", 0.00008, "deepseek-v4-flash-0731"),
    ]);

    expect(catalog["deepseek-v4-flash-0731"]).toEqual({
      provider: "scaleway",
      source: "scaleway",
      currency: "EUR",
      input_cost_per_token: 0.0004 / 1000,
      output_cost_per_token: 0.0008 / 1000,
      cache_read_input_token_cost: 0.00008 / 1000,
    });
  });

  // Batch is a different API at half price. Billing a real-time turn at it would halve every cost.
  it("ignores batch rows, which would understate a real-time turn", () => {
    const catalog = fromScalewayCatalog([
      row("qwen36_input", 0.00025),
      row("qwen36_output", 0.0015),
      row("qwen36_input_batch", 0.000125),
      row("qwen36_output_batch", 0.00075),
    ]);
    expect(catalog["qwen3.6-35b-a3b"]).toMatchObject({
      input_cost_per_token: 0.00025 / 1000,
      output_cost_per_token: 0.0015 / 1000,
    });
  });

  it("skips a model missing either half rather than billing completions at zero", () => {
    expect(fromScalewayCatalog([row("qwen36_input", 0.00025)])).toEqual({});
  });

  it("ignores models this app does not offer, and rows from another region", () => {
    const foreign = { ...row("gpt_oss_input", 0.0001, "gpt-oss-120b") };
    const elsewhere = { ...row("qwen36_input", 0.00025), locality: { region: "nl-ams" } };
    expect(fromScalewayCatalog([foreign, elsewhere])).toEqual({});
  });

  it("skips a retired row that carries no price at all", () => {
    const priceless = { ...row("qwen36_input", 0.00025), price: undefined };
    expect(fromScalewayCatalog([priceless, row("qwen36_output", 0.0015)])).toEqual({});
  });

  it("marks a successful but incomplete response as a source failure", async () => {
    const json = (body: object) =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // A same-named direct-provider row must not occupy the missing Scaleway model's slot.
        .mockImplementationOnce(() =>
          json({
            "deepseek-v4-flash-0731": {
              litellm_provider: "deepseek",
              input_cost_per_token: 1e-7,
              output_cost_per_token: 2e-7,
            },
          }),
        )
        // Only qwen is present; the other offered Scaleway model is silently absent from this 200.
        .mockImplementationOnce(() =>
          json({ products: [row("qwen36_input", 0.00025), row("qwen36_output", 0.0015)], total_count: 2 }),
        )
        .mockImplementationOnce(() => json({})),
    );

    const result = await buildCatalog();

    expect(result.scaleway).toEqual(["qwen3.6-35b-a3b"]);
    expect(result.sourceFailures).toContain("scaleway");
    expect(result.catalog["deepseek-v4-flash-0731"]).toBeUndefined();
  });

  /**
   * SCALEWAY_MODEL_EFFORTS is hand-maintained, so the only thing keeping it honest is this check
   * against the same rows the prices come from. It has to fail on a real move and stay quiet
   * otherwise, or `npm run update-pricing` either cries wolf or stops catching anything.
   */
  describe("reasoning-level drift", () => {
    const withEfforts = (product: string, supported: string[], fallback: string) => ({
      ...row("x_input", 0.0001, product),
      properties: { generative_apis: { supported_reasoning_values: supported, default_reasoning_value: fallback } },
    });

    it("stays silent while the catalog agrees with the checked-in table", () => {
      expect(
        scalewayEffortDrift([
          withEfforts("qwen3.6-35b-a3b", ["none", "medium"], "medium"),
          withEfforts("deepseek-v4-flash-0731", ["none", "low", "high", "max"], "high"),
        ]),
      ).toEqual([]);
    });

    it("reports a model whose supported levels moved", () => {
      const drift = scalewayEffortDrift([withEfforts("qwen3.6-35b-a3b", ["none", "low", "medium"], "medium")]);
      expect(drift).toHaveLength(1);
      expect(drift[0]).toContain("qwen3.6-35b-a3b");
      expect(drift[0]).toContain("none, low, medium");
    });

    it("reports a model whose default moved, even with the same levels", () => {
      expect(scalewayEffortDrift([withEfforts("qwen3.6-35b-a3b", ["none", "medium"], "none")])).toHaveLength(1);
    });

    // Order is the vendor's presentation, not a fact about the model — reordering must not cry wolf.
    it("compares levels as a set, not as an ordered list", () => {
      expect(scalewayEffortDrift([withEfforts("qwen3.6-35b-a3b", ["medium", "none"], "medium")])).toEqual([]);
    });

    // An absent source is not a changed one: a catalog that stops carrying the field would otherwise
    // fail every refresh with nothing actionable to say.
    it("says nothing about a model whose rows carry no reasoning field", () => {
      expect(scalewayEffortDrift([row("qwen36_input", 0.00025)])).toEqual([]);
    });
  });
});
