import { describe, expect, it } from "vitest";
import { isBoundedIntegerDraft } from "./integerDraft";

describe("isBoundedIntegerDraft", () => {
  it("allows an empty editing state and bounded positive integers", () => {
    expect(isBoundedIntegerDraft("", 1, 500)).toBe(true);
    expect(isBoundedIntegerDraft("1", 1, 500)).toBe(true);
    expect(isBoundedIntegerDraft("500", 1, 500)).toBe(true);
  });

  it.each(["0", "0.1", "E", "aaa", "-6", "+6", "01", "501"])("rejects invalid draft %s", (value) => {
    expect(isBoundedIntegerDraft(value, 1, 500)).toBe(false);
  });
});
