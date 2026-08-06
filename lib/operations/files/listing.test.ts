// A listing scoped to a path is the one file operation where answering *nothing* is plausible enough to
// be dangerous: an empty tree is what an empty directory looks like, so a path the caller got wrong has
// to fail instead. These pin that, and pin that the paths handed back stay usable as arguments.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AppError } from "@/lib/errors/appError";
import { listEntries } from "./listing";

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
});
