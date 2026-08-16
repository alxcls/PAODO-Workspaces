import { describe, expect, it } from "vitest";
import { fromLiteLLM } from "./refresh";

describe("model price refresh", () => {
  it("prices codestral-latest from the newest versioned row", () => {
    const catalog = fromLiteLLM({
      "mistral/codestral-latest": {
        litellm_provider: "mistral",
        input_cost_per_token: 1 / 1e6,
        output_cost_per_token: 3 / 1e6,
      },
      "mistral/codestral-2508": {
        litellm_provider: "mistral",
        input_cost_per_token: 0.3 / 1e6,
        output_cost_per_token: 0.9 / 1e6,
      },
    });

    expect(catalog["codestral-latest"]).toMatchObject({
      input_cost_per_token: 0.3 / 1e6,
      output_cost_per_token: 0.9 / 1e6,
    });
  });
});
