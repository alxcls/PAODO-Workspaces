import { describe, expect, it } from "vitest";
import { canMoveToDirectory, isPathWithinRoot, remapMovedPath } from "./fileMove";

describe("remapMovedPath", () => {
  it("remaps the moved item and its descendants", () => {
    expect(remapMovedPath("/ws/src", "/ws/src", "/ws/archive/src")).toBe("/ws/archive/src");
    expect(remapMovedPath("/ws/src/index.ts", "/ws/src", "/ws/archive/src"))
      .toBe("/ws/archive/src/index.ts");
  });

  it("does not remap similarly prefixed siblings", () => {
    expect(remapMovedPath("/ws/src-old/index.ts", "/ws/src", "/ws/archive/src"))
      .toBe("/ws/src-old/index.ts");
  });
});

describe("canMoveToDirectory", () => {
  const folder = { path: "/ws/src", type: "directory" as const };

  it("rejects a folder's own subtree", () => {
    expect(canMoveToDirectory(folder, "/ws/src")).toBe(false);
    expect(canMoveToDirectory(folder, "/ws/src/nested")).toBe(false);
  });

  it("allows files and unrelated destination folders", () => {
    expect(canMoveToDirectory(folder, "/ws/archive")).toBe(true);
    expect(canMoveToDirectory({ path: "/ws/src/a.ts", type: "file" }, "/ws/src")).toBe(true);
  });
});

describe("isPathWithinRoot", () => {
  it("matches a root and its descendants, but not similarly prefixed siblings", () => {
    expect(isPathWithinRoot("/ws/src", "/ws/src")).toBe(true);
    expect(isPathWithinRoot("/ws/src/a.ts", "/ws/src")).toBe(true);
    expect(isPathWithinRoot("/ws/src-old/a.ts", "/ws/src")).toBe(false);
  });
});
