// Tests for the workspace path containment guard (pathUtils.ts).

import { describe, it, expect } from "vitest";
import { normalizeRelpath, normalizeDirPath } from "./pathUtils";

// The single most important invariant in this app: the agent can never
// address a path outside its own workspace. normalizeRelpath/normalizeDirPath
// are the chokepoint that enforces it — every file tool routes through here.
// These tests assert BEHAVIOR (input -> allowed-or-rejected), so they survive
// any reimplementation of the guard's internals.

describe("normalizeRelpath — containment guard", () => {
  it("allows ordinary relative paths", () => {
    expect(normalizeRelpath("src/index.ts")).toBe("src/index.ts");
    expect(normalizeRelpath("a/b/c.txt")).toBe("a/b/c.txt");
  });

  it("collapses redundant segments to a clean relative path", () => {
    expect(normalizeRelpath("src/./a/../b.ts")).toBe("src/b.ts");
  });

  // --- the cases that matter: escapes MUST be rejected (null) ---

  it("rejects parent-directory traversal", () => {
    expect(normalizeRelpath("../secret")).toBeNull();
    expect(normalizeRelpath("a/../../etc/passwd")).toBeNull();
    expect(normalizeRelpath("..")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(normalizeRelpath("/etc/passwd")).toBeNull();
    expect(normalizeRelpath("/")).toBeNull();
  });
});

describe("normalizeDirPath — containment guard", () => {
  it("treats empty/current as the workspace root", () => {
    expect(normalizeDirPath(undefined)).toBe(".");
    expect(normalizeDirPath(".")).toBe(".");
  });

  it("allows ordinary subdirectories", () => {
    expect(normalizeDirPath("src/components")).toBe("src/components");
  });

  it("rejects escapes", () => {
    expect(normalizeDirPath("..")).toBeNull();
    expect(normalizeDirPath("../..")).toBeNull();
    expect(normalizeDirPath("/var")).toBeNull();
  });
});
