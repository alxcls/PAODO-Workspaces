// Invariant: the mention list ranks basename matches above path-only matches, stays case-insensitive
// and capped, and never truncates a basename out of the displayed path. Bug class guarded: the popup
// burying the file you typed under unrelated deep matches, or a garbled/oversized row breaking layout.

import { describe, it, expect } from "vitest";
import { filterMentions, truncateMiddlePath } from "./mentionFilter";
import type { TreeNode } from "./hooks/useFileOperations";

function file(path: string): TreeNode {
  return { name: path.split("/").pop() ?? path, type: "file", path };
}

describe("filterMentions", () => {
  const candidates = [
    file("auth/config.ts"),
    file("doc/api/auth.ts"),
    file("src/authenticate.ts"),
    file("lib/misc.ts"),
  ];

  it("returns the first N in order for an empty query", () => {
    expect(filterMentions(candidates, "", 2)).toEqual([candidates[0], candidates[1]]);
  });

  it("ranks basename prefix above basename substring above path-only match", () => {
    const res = filterMentions(candidates, "auth", 10).map((n) => n.path);
    expect(res).toEqual(["doc/api/auth.ts", "src/authenticate.ts", "auth/config.ts"]);
  });

  it("is case-insensitive", () => {
    expect(filterMentions(candidates, "AUTH", 10).map((n) => n.path)).toContain("doc/api/auth.ts");
  });

  it("respects the cap", () => {
    expect(filterMentions(candidates, "auth", 1)).toHaveLength(1);
  });

  it("drops non-matches", () => {
    expect(filterMentions(candidates, "auth", 10).map((n) => n.path)).not.toContain("lib/misc.ts");
  });
});

describe("truncateMiddlePath", () => {
  it("leaves a short path unchanged", () => {
    expect(truncateMiddlePath("src/main.ts", 40)).toBe("src/main.ts");
  });

  it("drops leading ancestors and keeps the tail with an ellipsis prefix", () => {
    const path = "doc/services/ingest/handlers/v2/internal/auth-callback-controller.ts";
    const out = truncateMiddlePath(path, 40);
    expect(out.startsWith("…/")).toBe(true);
    expect(out.endsWith("auth-callback-controller.ts")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(42);
  });

  it("never truncates the basename itself", () => {
    const path = "a/b/c/a-very-long-single-file-name-that-exceeds-the-limit.ts";
    const out = truncateMiddlePath(path, 20);
    expect(out).toContain("a-very-long-single-file-name-that-exceeds-the-limit.ts");
  });
});
