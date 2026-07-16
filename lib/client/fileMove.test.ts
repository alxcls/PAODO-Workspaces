import { describe, expect, it } from "vitest";
import {
  canMoveAllToDirectory,
  canMoveToDirectory,
  collapseToRoots,
  isPathWithinRoot,
  remapMovedPath,
} from "./fileMove";

describe("remapMovedPath", () => {
  it("remaps the moved item and its descendants", () => {
    expect(remapMovedPath("/ws/src", "/ws/src", "/ws/archive/src")).toBe("/ws/archive/src");
    expect(remapMovedPath("/ws/src/index.ts", "/ws/src", "/ws/archive/src")).toBe("/ws/archive/src/index.ts");
  });

  it("does not remap similarly prefixed siblings", () => {
    expect(remapMovedPath("/ws/src-old/index.ts", "/ws/src", "/ws/archive/src")).toBe("/ws/src-old/index.ts");
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

describe("collapseToRoots", () => {
  it("drops paths that already travel with a selected ancestor", () => {
    expect(collapseToRoots(["/ws/src", "/ws/src/index.ts", "/ws/src/lib", "/ws/src/lib/a.ts"])).toEqual(["/ws/src"]);
  });

  it("keeps unrelated roots, including similarly prefixed siblings", () => {
    expect(collapseToRoots(["/ws/src", "/ws/src-old/a.ts", "/ws/docs"])).toEqual([
      "/ws/src",
      "/ws/src-old/a.ts",
      "/ws/docs",
    ]);
  });

  it("keeps a nested path when its ancestor is not itself selected", () => {
    expect(collapseToRoots(["/ws/src/index.ts", "/ws/docs"])).toEqual(["/ws/src/index.ts", "/ws/docs"]);
  });

  it("handles the empty selection", () => {
    expect(collapseToRoots([])).toEqual([]);
  });
});

describe("canMoveAllToDirectory", () => {
  const file = { path: "/ws/a.ts", type: "file" as const };
  const folder = { path: "/ws/src", type: "directory" as const };

  it("accepts a destination every source allows", () => {
    expect(canMoveAllToDirectory([file, folder], "/ws/archive")).toBe(true);
  });

  it("refuses the whole batch when one source rejects the destination", () => {
    expect(canMoveAllToDirectory([file, folder], "/ws/src/nested")).toBe(false);
  });

  it("refuses an empty batch", () => {
    expect(canMoveAllToDirectory([], "/ws/archive")).toBe(false);
  });
});

describe("isPathWithinRoot", () => {
  it("matches a root and its descendants, but not similarly prefixed siblings", () => {
    expect(isPathWithinRoot("/ws/src", "/ws/src")).toBe(true);
    expect(isPathWithinRoot("/ws/src/a.ts", "/ws/src")).toBe(true);
    expect(isPathWithinRoot("/ws/src-old/a.ts", "/ws/src")).toBe(false);
  });
});
