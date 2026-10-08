import { describe, expect, it } from "vitest";
import { uncachedInputTokens } from "./tokenUsage";

describe("uncachedInputTokens", () => {
  it("subtracts cache reads from total input", () => {
    expect(uncachedInputTokens(1_000, 600)).toBe(400);
  });

  it("clamps inconsistent provider metadata at zero", () => {
    expect(uncachedInputTokens(100, 120)).toBe(0);
  });
});
