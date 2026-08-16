import { describe, expect, it } from "vitest";
import { isMistralToolCallId, newMistralToolCallId } from "./toolCallIds";

const VALID = /^[A-Za-z0-9]{9}$/;

describe("Mistral tool-call ids", () => {
  it.each([
    ["abc123XYZ", true],
    ["abc123XY", false],
    ["abc123XYZ0", false],
    ["abc_123XY", false],
    ["abc-123XY", false],
  ])("validates %s", (id, expected) => {
    expect(isMistralToolCallId(id)).toBe(expected);
  });

  it("mints distinct 9-character alphanumeric ids", () => {
    const taken = new Set<string>();
    const ids = Array.from({ length: 100 }, () => newMistralToolCallId(taken));
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) expect(id).toMatch(VALID);
  });
});
