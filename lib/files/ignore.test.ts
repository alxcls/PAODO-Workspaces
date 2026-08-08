// The ignore contract decides what a file transfer sends and what it leaves out, in both directions.
// The invariants worth pinning: whole-segment matching only (no false positives on similarly-named
// files), nested occurrences are still caught, and the excluded bucket is grouped by which rule
// matched — that grouping is what lets the results summary say "node_modules excluded (14,200 files)"
// instead of just a bare count.
//
// Also pinned here: the directory walker and a flat path list agree. partitionByIgnore (a browser
// upload, which knows every relative path up front) and ignoreRuleFor (a server walk, which decides
// per entry as it descends) are the same contract expressed for two different traversals, and a
// transfer built on both only round-trips cleanly while they stay in step.

import { describe, it, expect } from "vitest";
import {
  partitionByIgnore,
  ignoreRuleFor,
  IGNORED_DIR_NAMES,
  IGNORED_FILE_SUFFIXES,
  REGENERATED_DIR_NAMES,
  VCS_DIR_NAMES,
} from "./ignore";

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

  it("never treats the file's own name as a directory match", () => {
    const { included, excluded } = partitionByIgnore([entry("src/node_modules")]);
    expect(included).toEqual([entry("src/node_modules")]);
    expect(excluded.size).toBe(0);
  });

  it("groups multiple excluded entries under the same ignored-name bucket", () => {
    const { excluded } = partitionByIgnore([entry("node_modules/a.js"), entry("node_modules/b.js")]);
    expect(excluded.get("node_modules")).toHaveLength(2);
  });

  it("defaults to the effective contract when none is passed", () => {
    const { excluded } = partitionByIgnore([entry("node_modules/a.js")]);
    expect(excluded.has(IGNORED_DIR_NAMES[0])).toBe(true);
  });

  it("respects a custom contract, including excluding nothing", () => {
    const { included } = partitionByIgnore([entry("node_modules/a.js")], { dirNames: [], fileSuffixes: [] });
    expect(included).toEqual([entry("node_modules/a.js")]);
  });

  it.each(["__pycache__", ".venv", "venv", ".next", ".turbo", ".gradle", ".ruff_cache"])(
    "excludes the regenerated directory %s",
    (dirName) => {
      const { excluded } = partitionByIgnore([entry(`${dirName}/generated.bin`)]);
      expect(excluded.get(dirName)).toEqual([entry(`${dirName}/generated.bin`)]);
    },
  );

  // The file tree has always hidden .git, so before the contract was unified a folder upload sent a
  // .git the UI then refused to show. Both directions now agree it does not travel.
  it("excludes the workspace's own git metadata", () => {
    const { included, excluded } = partitionByIgnore([entry(".git/objects/ab/cdef"), entry("README.md")]);
    expect(included).toEqual([entry("README.md")]);
    expect(excluded.get(".git")).toHaveLength(1);
  });

  it.each(IGNORED_FILE_SUFFIXES)("excludes a stray %s file outside any ignored directory", (suffix) => {
    const { included, excluded } = partitionByIgnore([entry(`src/mod${suffix}`), entry("src/mod.py")]);
    expect(included).toEqual([entry("src/mod.py")]);
    expect(excluded.get(suffix)).toEqual([entry(`src/mod${suffix}`)]);
  });
});

describe("ignoreRuleFor", () => {
  it("excludes every contract directory name, and only as a directory", () => {
    for (const name of IGNORED_DIR_NAMES) {
      expect(ignoreRuleFor(name, true)).toBe(name);
      // A *file* that happens to share the name is content, not a build directory.
      expect(ignoreRuleFor(name, false)).toBeUndefined();
    }
  });

  it("agrees with partitionByIgnore on the same relative path", () => {
    const paths = ["src/index.ts", "node_modules/react/index.js", ".git/config", "src/mod.pyc", "src/node_modules"];
    const { excluded } = partitionByIgnore(paths.map(entry));
    const excludedByList = new Set(
      Array.from(excluded.values())
        .flat()
        .map((item) => item.path),
    );

    for (const relPath of paths) {
      const segments = relPath.split("/");
      // What a walker concludes: any directory segment excluded, or the leaf excluded as a file.
      const excludedByWalk =
        segments.slice(0, -1).some((segment) => ignoreRuleFor(segment, true) !== undefined) ||
        ignoreRuleFor(segments[segments.length - 1], false) !== undefined;
      expect(excludedByWalk).toBe(excludedByList.has(relPath));
    }
  });
});

describe("the contract itself", () => {
  it("is the regenerated names plus the VCS names, with no duplicates", () => {
    expect(IGNORED_DIR_NAMES).toEqual([...REGENERATED_DIR_NAMES, ...VCS_DIR_NAMES]);
    expect(new Set(IGNORED_DIR_NAMES).size).toBe(IGNORED_DIR_NAMES.length);
  });
});
