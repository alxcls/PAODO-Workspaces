// A listing scoped to a path is the one file operation where answering *nothing* is plausible enough to
// be dangerous: an empty tree is what an empty directory looks like, so a path the caller got wrong has
// to fail instead. These pin that, and pin that the paths handed back stay usable as arguments.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AppError } from "@/lib/errors/appError";
import { listEntries as listing } from "./listing";

// Every assertion below is about the tree itself, so they read it directly; the `truncated` flag beside
// it has its own block at the bottom.
const listEntries = async (...args: Parameters<typeof listing>) => (await listing(...args)).tree;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "file-listing-operation-test-"));
const WS = path.join(ROOT, "ws");

/** Host paths, for building fixtures only — never an argument to listEntries. */
const abs = (relPath: string) => path.join(WS, relPath);

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(abs("src/lib"), { recursive: true });
  fs.writeFileSync(abs("AGENTS.md"), "read me\n");
  fs.writeFileSync(abs("src/main.ts"), "main\n");
  fs.writeFileSync(abs("src/lib/util.ts"), "util\n");
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** Every path in a tree, so a test can assert the naming without walking it by hand. */
function paths(nodes: Awaited<ReturnType<typeof listEntries>>): string[] {
  return nodes.flatMap((node) => [node.path, ...paths(node.children ?? [])]).sort();
}

describe("listEntries", () => {
  it("lists the whole workspace when no path is named", async () => {
    for (const root of [null, undefined, "", ".", "./"]) {
      expect(paths(await listEntries(WS, root, { maxDepth: Infinity }))).toEqual([
        "AGENTS.md",
        "src",
        "src/lib",
        "src/lib/util.ts",
        "src/main.ts",
      ]);
    }
  });

  // The reason a subtree listing is worth having at all: what comes back can be handed straight to
  // cat, get and rm. If these were named from the listed directory, "main.ts" would name nothing.
  it("names a subtree's entries from the workspace root, not from the directory listed", async () => {
    expect(paths(await listEntries(WS, "src", { maxDepth: Infinity }))).toEqual([
      "src/lib",
      "src/lib/util.ts",
      "src/main.ts",
    ]);
    expect(await listEntries(WS, "src/lib", { maxDepth: Infinity })).toEqual([
      { name: "util.ts", type: "file", path: "src/lib/util.ts" },
    ]);
  });

  it("accepts the trailing slash and the redundant segments a caller may hand back", async () => {
    for (const spelling of ["src/", "./src", "src/lib/..", "src//lib/../"]) {
      expect(paths(await listEntries(WS, spelling, { maxDepth: Infinity }))).toEqual([
        "src/lib",
        "src/lib/util.ts",
        "src/main.ts",
      ]);
    }
  });

  it("counts depth from the directory listed, not from the workspace root", async () => {
    expect(paths(await listEntries(WS, "src", { maxDepth: 1 }))).toEqual(["src/lib", "src/main.ts"]);
  });

  // `ls` of a file answers with the file. The alternative is an error for a question with a true
  // answer, and it would make "does this path exist" impossible to ask without knowing its kind first.
  it("answers with the one entry when the path names a file", async () => {
    expect(await listEntries(WS, "src/main.ts")).toEqual([{ name: "main.ts", type: "file", path: "src/main.ts" }]);
  });

  it("fails with NOT_FOUND rather than an empty listing for a path that is not there", async () => {
    await expect(listEntries(WS, "src/nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "src/nope does not exist",
    });
    await expect(listEntries(WS, "src/nope")).rejects.toBeInstanceOf(AppError);
  });

  it("fails when the path runs through a file", async () => {
    await expect(listEntries(WS, "AGENTS.md/inner")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("applies the shared ignore contract, so a listing shows what a transfer would carry", async () => {
    fs.mkdirSync(abs("src/node_modules"));
    fs.writeFileSync(abs("src/node_modules/dep.js"), "dep\n");
    expect(paths(await listEntries(WS, "src", { maxDepth: Infinity }))).toEqual([
      "src/lib",
      "src/lib/util.ts",
      "src/main.ts",
    ]);
  });

  // What a caller needs before it reads a file: how long it is, in the unit `cat --offset`/`--limit`
  // count. Off by default, because the file panel makes most of these requests and a line count costs
  // a read per entry.
  describe("measure", () => {
    it("adds nothing at all unless it is asked for", async () => {
      const [file] = await listEntries(WS, "src/main.ts");
      expect(file).toEqual({ name: "main.ts", type: "file", path: "src/main.ts" });
    });

    it("reports a file's line count, at every level of the tree", async () => {
      fs.writeFileSync(abs("src/lib/util.ts"), "one\ntwo\nthree");
      const tree = await listEntries(WS, null, { maxDepth: Infinity, measure: true });
      const find = (relPath: string): Record<string, unknown> | undefined => {
        const walk = (nodes: Awaited<ReturnType<typeof listEntries>>): Record<string, unknown> | undefined => {
          for (const node of nodes) {
            if (node.path === relPath) return node as unknown as Record<string, unknown>;
            const found = walk(node.children ?? []);
            if (found) return found;
          }
        };
        return walk(tree);
      };
      expect(find("AGENTS.md")).toMatchObject({ lines: 1 });
      // A last line with no terminator still counts, so a caller reading to `lines` gets all of it.
      expect(find("src/lib/util.ts")).toMatchObject({ lines: 3 });
      // A directory is not a thing with a length.
      expect(find("src")).not.toHaveProperty("lines");
    });

    // `lines` appears on exactly the files a caller can window — the same classification the content
    // route refuses an `?offset=` against, so a listing never advertises a window `cat` would reject.
    it("leaves a file with no lines to count without a line count", async () => {
      fs.writeFileSync(abs("blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
      fs.writeFileSync(abs("logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      const tree = await listEntries(WS, null, { measure: true });
      const entry = (relPath: string) => tree.find((node) => node.path === relPath);
      expect(entry("blob.bin")).not.toHaveProperty("lines");
      // An SVG is text on disk and an image to the reader, and the read route refuses to window it.
      expect(entry("logo.svg")).not.toHaveProperty("lines");
    });

    it("measures a single file named directly, not just entries of a directory", async () => {
      expect(await listEntries(WS, "AGENTS.md", { measure: true })).toEqual([
        { name: "AGENTS.md", type: "file", path: "AGENTS.md", lines: 1 },
      ]);
    });
  });

  // What a caller needs before it descends: whether a directory is worth going into. A tree alone cannot
  // say — the answer is below the level being listed, which is exactly what the caller cannot see.
  describe("countFiles", () => {
    /** A node by the path it is named at, since a listing comes back in readdir order. */
    const at = (nodes: Awaited<ReturnType<typeof listEntries>>, relPath: string) =>
      nodes.find((node) => node.path === relPath)!;

    it("adds nothing at all unless it is asked for", async () => {
      const [dir] = await listEntries(WS, "src/lib");
      expect(dir).not.toHaveProperty("files");
    });

    it("counts every file under a directory, however deep, and leaves files uncounted", async () => {
      const src = at(await listEntries(WS, null, { countFiles: true }), "src");
      expect(src.files).toBe(2); // src/main.ts and src/lib/util.ts
      expect(at(src.children!, "src/lib").files).toBe(1);
      expect(await listEntries(WS, "AGENTS.md", { countFiles: true })).toEqual([
        { name: "AGENTS.md", type: "file", path: "AGENTS.md" },
      ]);
    });

    // The whole point of the count: a listing that stops at one level hands back an empty branch, and the
    // number is the only thing in the answer that says how much is behind it.
    it("counts past the depth the listing itself stops at", async () => {
      fs.mkdirSync(abs("src/lib/deep/deeper"), { recursive: true });
      fs.writeFileSync(abs("src/lib/deep/deeper/buried.ts"), "buried\n");

      const src = at(await listEntries(WS, null, { maxDepth: 1, countFiles: true }), "src");
      expect(src.children).toEqual([]);
      expect(src.files).toBe(3); // main.ts, lib/util.ts and the buried one, none of them listed
    });

    // The count describes the tree the caller is looking at. A number that included what the listing
    // hides would describe a directory they cannot navigate — and would report the same node_modules the
    // listing exists to keep out of the way.
    it("counts only what the ignore contract lets the listing show", async () => {
      fs.mkdirSync(abs("src/node_modules/dep"), { recursive: true });
      fs.writeFileSync(abs("src/node_modules/dep/index.js"), "dep\n");

      expect(at(await listEntries(WS, null, { countFiles: true }), "src").files).toBe(2);
    });

    it("reports an empty directory as holding nothing, rather than saying nothing about it", async () => {
      fs.mkdirSync(abs("src/hollow/inner"), { recursive: true });
      const src = at(await listEntries(WS, null, { countFiles: true }), "src");
      expect(at(src.children!, "src/hollow").files).toBe(0);
    });
  });

  describe("containment", () => {
    it("refuses a path that escapes the root, however it is spelled", async () => {
      for (const escape of ["..", "../ws", "/etc", "/workspace/src"]) {
        await expect(listEntries(WS, escape)).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          details: { field: "path" },
        });
      }
    });

    // The case a lexical check cannot see: an ordinary-looking relative path that is a symlink out of
    // the workspace. Listing through it would enumerate a host directory the client cannot name.
    it("refuses a symlink that leaves the workspace", async () => {
      fs.mkdirSync(path.join(ROOT, "outside"));
      fs.writeFileSync(path.join(ROOT, "outside", "secret.txt"), "TOPSECRET");
      fs.symlinkSync(path.join(ROOT, "outside"), abs("escape"));
      await expect(listEntries(WS, "escape")).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "Path resolves outside the workspace",
      });
    });

    it("lists through a symlink that stays inside it, as the tree already lists the link itself", async () => {
      fs.symlinkSync(abs("src/lib"), abs("linked"));
      expect(await listEntries(WS, "linked", { maxDepth: Infinity })).toEqual([
        { name: "util.ts", type: "file", path: "linked/util.ts" },
      ]);
    });
  });
  // Breadth, the half of a listing maxDepth does not bound. The ceiling has to stop the scan rather
  // than trim its result, and it has to be visible: a prefix presented as a whole directory is the one
  // answer a caller cannot tell from a complete one.
  describe("the entry ceiling", () => {
    const wide = (count: number) => {
      fs.mkdirSync(abs("wide"), { recursive: true });
      for (let i = 0; i < count; i++) fs.writeFileSync(abs(`wide/f${String(i).padStart(4, "0")}.txt`), "x\n");
    };

    it("returns everything and reports nothing when no ceiling is asked for", async () => {
      wide(50);
      const { tree, truncated } = await listing(WS, "wide");
      expect(tree).toHaveLength(50);
      expect(truncated).toBe(false);
    });

    it("returns everything and reports nothing when the directory fits under the ceiling", async () => {
      wide(9);
      const { tree, truncated } = await listing(WS, "wide", { maxEntries: 10 });
      expect(tree).toHaveLength(9);
      expect(truncated).toBe(false);
    });

    // The boundary both ways: exactly at the ceiling is whole, one past it is cut.
    it("is not truncated at exactly the ceiling, and is one entry past it", async () => {
      wide(10);
      expect(await listing(WS, "wide", { maxEntries: 10 })).toMatchObject({ truncated: false });
      expect(await listing(WS, "wide", { maxEntries: 9 })).toMatchObject({ truncated: true });
    });

    it("caps the entries and says so", async () => {
      wide(50);
      const { tree, truncated } = await listing(WS, "wide", { maxEntries: 10 });
      expect(tree).toHaveLength(10);
      expect(truncated).toBe(true);
    });

    // The flag has to survive the trip up the walk: the directory that was cut is not the one the
    // caller named, and at the root there is no node to carry a flag at all.
    it("reports a cut in a subdirectory, and marks the directory it happened in", async () => {
      wide(50);
      const { tree, truncated } = await listing(WS, null, { maxDepth: Infinity, maxEntries: 10 });
      expect(truncated).toBe(true);
      expect(tree.find((node) => node.path === "wide")).toMatchObject({ truncated: true });
      // The directories that were whole say nothing, so the flag marks where the cut is.
      expect(tree.find((node) => node.path === "src")).not.toHaveProperty("truncated");
    });

    // Measuring runs after the cut, so it costs a read per entry the caller is shown rather than per
    // entry the directory holds — the difference between 10 reads and 50 here.
    it("measures only the entries that survived the cut", async () => {
      wide(50);
      const { tree } = await listing(WS, "wide", { maxEntries: 10, measure: true });
      expect(tree).toHaveLength(10);
      for (const node of tree) expect(node).toHaveProperty("lines", 1);
    });

    // The count answers "how much is really in here", which is exactly what the truncated listing
    // cannot show — so it must not itself be capped.
    it("counts the whole directory even though the listing of it was cut", async () => {
      wide(50);
      const { tree } = await listing(WS, null, { maxDepth: 1, maxEntries: 10, countFiles: true });
      expect(tree.find((node) => node.path === "wide")).toMatchObject({ files: 50 });
    });

    it("never truncates a path that names a single file", async () => {
      expect(await listing(WS, "AGENTS.md", { maxEntries: 1 })).toMatchObject({ truncated: false });
    });
  });
});
