// The point of this type is not to describe one provider — it is to make an IRRECONCILABLE pair of
// providers fail loudly, at module load, on the branch that introduces the second one. These tests
// pin that: intersection narrows, and a demand that cannot be met throws while naming both sides.
import { describe, it, expect } from "vitest";
import {
  ALPHANUMERIC,
  BASELINE_CONSTRAINT,
  narrowestConstraint,
  satisfiesConstraint,
  type ToolCallIdConstraint,
} from "./toolCallIdConstraint";

const MISTRAL: ToolCallIdConstraint = { name: "mistral", alphabet: ALPHANUMERIC, minLength: 9, maxLength: 9 };
// A provider that mints and validates prefixed ids — the shape that has no overlap with mistral's
// ceiling. This is the hypothetical the whole type exists to catch.
const PREFIXING: ToolCallIdConstraint = {
  name: "hypothetical",
  alphabet: `${ALPHANUMERIC}_`,
  minLength: 20,
  maxLength: 40,
};

describe("satisfiesConstraint", () => {
  it.each([
    ["exactly at the length", "abc123XYZ", true],
    ["one short", "abc123XY", false],
    ["one long", "abc123XYZ0", false],
    ["carrying an underscore", "abc_123XY", false],
    ["carrying a dash", "abc-123XY", false],
    ["empty", "", false],
  ])("treats an id %s as satisfying=%s", (_label, id, expected) => {
    expect(satisfiesConstraint(id, MISTRAL)).toBe(expected);
  });
});

describe("narrowestConstraint", () => {
  it("falls back to the app baseline when no provider demands anything", () => {
    expect(narrowestConstraint([])).toEqual(BASELINE_CONSTRAINT);
  });

  it("narrows the baseline to the single demand that exists today", () => {
    const resolved = narrowestConstraint([MISTRAL]);
    expect(resolved.alphabet).toBe(ALPHANUMERIC);
    expect(resolved.minLength).toBe(9);
    expect(resolved.maxLength).toBe(9);
  });

  // Order-independence matters because the demands are read off an object literal: a provider moved
  // for readability must not change the id shape the app generates.
  it("resolves the same shape whatever order the demands arrive in", () => {
    const other: ToolCallIdConstraint = { name: "other", alphabet: ALPHANUMERIC, minLength: 4, maxLength: 32 };
    const forward = narrowestConstraint([MISTRAL, other]);
    const reverse = narrowestConstraint([other, MISTRAL]);
    expect({ ...forward, name: "" }).toEqual({ ...reverse, name: "" });
  });

  // The load-bearing case. A length demand past another provider's ceiling leaves no id that both
  // would accept, and the app stores exactly one id per call.
  it("throws when two length demands cannot both be met, naming both sides", () => {
    expect(() => narrowestConstraint([MISTRAL, PREFIXING])).toThrow(/mistral/);
    expect(() => narrowestConstraint([MISTRAL, PREFIXING])).toThrow(/hypothetical/);
    // The message has to point at the documented way out, or the next reader widens a constraint to
    // silence it — which produces ids mistral rejects, the exact bug the module prevents.
    expect(() => narrowestConstraint([MISTRAL, PREFIXING])).toThrow(/toolCallIds\.ts/);
  });

  it("throws when two alphabets share no characters", () => {
    const digits: ToolCallIdConstraint = { name: "digits", alphabet: "0123456789", minLength: 9, maxLength: 9 };
    const letters: ToolCallIdConstraint = { name: "letters", alphabet: "abcdef", minLength: 9, maxLength: 9 };
    expect(() => narrowestConstraint([digits, letters])).toThrow(/no tool-call id shape satisfies both/);
  });
});
