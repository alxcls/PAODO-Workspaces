import { describe, expect, it } from "vitest";
import type { TreeNode } from "./hooks/useFileOperations";
import { flattenVisible, pathWithDescendants, selectionRange, sortTreeNodes } from "./fileTreeOrder";

// Deliberately declared out of display order: directories before files, each alphabetical.
const tree: TreeNode[] = [
  { name: "root.ts", type: "file", path: "/ws/root.ts" },
  {
    name: "src", type: "directory", path: "/ws/src",
    children: [
      { name: "a.ts", type: "file", path: "/ws/src/a.ts" },
      {
        name: "lib", type: "directory", path: "/ws/src/lib",
        children: [{ name: "deep.ts", type: "file", path: "/ws/src/lib/deep.ts" }],
      },
    ],
  },
  {
    name: "docs", type: "directory", path: "/ws/docs",
    children: [{ name: "guide.md", type: "file", path: "/ws/docs/guide.md" }],
  },
];

const paths = (nodes: TreeNode[]) => nodes.map((n) => n.path);

describe("sortTreeNodes", () => {
  it("puts directories first, then sorts each group by name", () => {
    expect(paths(sortTreeNodes(tree))).toEqual(["/ws/docs", "/ws/src", "/ws/root.ts"]);
  });

  it("does not mutate its input", () => {
    const original = [...tree];
    sortTreeNodes(tree);
    expect(tree).toEqual(original);
  });
});

describe("flattenVisible", () => {
  it("hides the subtree of a collapsed folder", () => {
    expect(paths(flattenVisible(tree, {}))).toEqual(["/ws/docs", "/ws/src", "/ws/root.ts"]);
  });

  it("reveals only one level per expanded folder", () => {
    expect(paths(flattenVisible(tree, { "/ws/src": true })))
      .toEqual(["/ws/docs", "/ws/src", "/ws/src/lib", "/ws/src/a.ts", "/ws/root.ts"]);
  });

  it("reveals nested folders when both are expanded", () => {
    expect(paths(flattenVisible(tree, { "/ws/src": true, "/ws/src/lib": true })))
      .toEqual([
        "/ws/docs", "/ws/src", "/ws/src/lib", "/ws/src/lib/deep.ts", "/ws/src/a.ts", "/ws/root.ts",
      ]);
  });
});

describe("pathWithDescendants", () => {
  it("returns a file on its own", () => {
    expect(pathWithDescendants(tree[0])).toEqual(["/ws/root.ts"]);
  });

  it("carries a folder's whole subtree, expanded or not", () => {
    expect(pathWithDescendants(tree[1]))
      .toEqual(["/ws/src", "/ws/src/lib", "/ws/src/lib/deep.ts", "/ws/src/a.ts"]);
  });
});

describe("selectionRange", () => {
  const rows = flattenVisible(tree, {});

  it("selects everything between the anchor and a row below it", () => {
    expect(selectionRange(rows, "/ws/docs", "/ws/root.ts")).toEqual([
      "/ws/docs", "/ws/docs/guide.md",
      "/ws/src", "/ws/src/lib", "/ws/src/lib/deep.ts", "/ws/src/a.ts",
      "/ws/root.ts",
    ]);
  });

  it("selects the same range when clicking above the anchor", () => {
    expect(selectionRange(rows, "/ws/root.ts", "/ws/docs"))
      .toEqual(selectionRange(rows, "/ws/docs", "/ws/root.ts"));
  });

  it("pulls in the hidden contents of a collapsed folder caught in the range", () => {
    expect(selectionRange(rows, "/ws/docs", "/ws/src")).toContain("/ws/src/lib/deep.ts");
  });

  it("selects the clicked row alone when there is no anchor yet", () => {
    expect(selectionRange(rows, null, "/ws/src"))
      .toEqual(["/ws/src", "/ws/src/lib", "/ws/src/lib/deep.ts", "/ws/src/a.ts"]);
  });

  it("selects the clicked row alone when the anchor has left the visible rows", () => {
    // The anchor's folder was collapsed between the two clicks.
    expect(selectionRange(rows, "/ws/src/lib/deep.ts", "/ws/root.ts")).toEqual(["/ws/root.ts"]);
  });

  it("selects just the anchor when it is clicked again", () => {
    expect(selectionRange(rows, "/ws/root.ts", "/ws/root.ts")).toEqual(["/ws/root.ts"]);
  });

  it("returns nothing when the clicked row is not visible", () => {
    expect(selectionRange(rows, "/ws/docs", "/ws/gone.ts")).toEqual([]);
  });
});
