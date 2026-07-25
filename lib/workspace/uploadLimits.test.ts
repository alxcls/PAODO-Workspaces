// formatBytes renders the sizes in the 413 response and in the UI's "nothing was uploaded" message,
// which is the whole point of that message: a user who is told a file is "over the limit" without
// legible numbers has learned nothing. The invariants worth holding are that a size never renders as
// a useless "0", that it picks the largest unit that keeps the value at or above 1, and that the
// limit itself reads as a round number rather than "1024 MB".

import { describe, it, expect } from "vitest";
import { MAX_UPLOAD_BYTES, formatBytes } from "./uploadLimits";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1 KB"],
    [1024 * 1024, "1 MB"],
    [1024 * 1024 * 1024, "1 GB"],
    [1024 ** 4, "1 TB"],
  ])("renders %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("keeps a decimal only where rounding would otherwise lose the whole magnitude", () => {
    // Small fractional values need the decimal to stay meaningful...
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    // ...while larger ones read better as integers.
    expect(formatBytes(734.2 * 1024 * 1024)).toBe("734 MB");
  });

  it("never renders a non-zero size as 0", () => {
    for (const bytes of [1, 1023, 1025, 1024 * 1024 - 1, MAX_UPLOAD_BYTES - 1]) {
      expect(formatBytes(bytes)).not.toMatch(/^0(\.0)? /);
    }
  });

  it("caps at TB rather than running out of units", () => {
    expect(formatBytes(5 * 1024 ** 5)).toMatch(/TB$/);
  });

  it("renders the configured limit as a round figure users can repeat back", () => {
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe("1 GB");
  });
});
