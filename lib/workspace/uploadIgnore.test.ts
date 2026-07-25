// partitionByIgnore decides what a folder upload silently sends vs. visibly leaves out. The
// invariants worth pinning: whole-segment matching only (no false positives on similarly-named
// files), nested occurrences are still caught, and the excluded bucket is grouped by which ignored
// name matched — that grouping is what lets the UI say "excluded: node_modules (14,200 files)"
// instead of just a bare count.

import { describe, it, expect } from "vitest";
import { partitionByIgnore, DEFAULT_IGNORED_DIR_NAMES } from "./uploadIgnore";

const entry = (path: string) => ({ path });

describe("partitionByIgnore", () => {
  it("excludes a file under a top-level ignored directory", () => {
    const { included, excluded } = partitionByIgnore([entry("node_modules/react/index.js"), entry("src/index.ts")]);
    expect(included).toEqual([entry("src/index.ts")]);
    expect(excluded.get("node_modules")).toEqual([entry("node_modules/react/index.js")]);
  });

  it("catches a nested occurrence, not just top-level", () => {
    const { included, excluded } = partitionByIgnore([entry("packages/api/node_modules/lodash/index.js")]);
    expect(included).toEqual([]);
    expect(excluded.get("node_modules")).toEqual([entry("packages/api/node_modules/lodash/index.js")]);
  });

  it("never mistakes a similarly-named file or directory for a whole-segment match", () => {
    const { included, excluded } = partitionByIgnore([
      entry("my-node_modules-notes.txt"),
      entry("node_modules_backup/file.txt"),
    ]);
    expect(included).toHaveLength(2);
    expect(excluded.size).toBe(0);
  });

  it("never treats the file's own name (the last segment) as a directory match", () => {
    const { included, excluded } = partitionByIgnore([entry("src/node_modules")]);
    expect(included).toEqual([entry("src/node_modules")]);
    expect(excluded.size).toBe(0);
  });

  it("groups multiple excluded entries under the same ignored-name bucket", () => {
    const { excluded } = partitionByIgnore([entry("node_modules/a.js"), entry("node_modules/b.js")]);
    expect(excluded.get("node_modules")).toHaveLength(2);
  });

  it("defaults to DEFAULT_IGNORED_DIR_NAMES when no list is passed", () => {
    const { excluded } = partitionByIgnore([entry("node_modules/a.js")]);
    expect(excluded.has(DEFAULT_IGNORED_DIR_NAMES[0])).toBe(true);
  });

  it("respects a custom ignore list, including excluding nothing", () => {
    const { included } = partitionByIgnore([entry("node_modules/a.js")], []);
    expect(included).toEqual([entry("node_modules/a.js")]);
  });

  it.each(["__pycache__", ".venv", "venv", ".next", ".turbo", ".gradle"])(
    "excludes the default entry %s",
    (dirName) => {
      const { excluded } = partitionByIgnore([entry(`${dirName}/generated.bin`)]);
      expect(excluded.get(dirName)).toEqual([entry(`${dirName}/generated.bin`)]);
    },
  );
});
