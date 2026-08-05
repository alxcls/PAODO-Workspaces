// The download route zips a caller-selected set of workspace-relative paths — the same space the file
// tree serves, so the browser can hand a selection straight back.
//
// A directory with no files anywhere beneath it is easy to lose: JSZip only materializes a folder once
// something is placed inside it, so without an explicit folder entry an empty dir (e.g. a fresh
// `.skills/`) silently vanishes from the archive. These tests pin that empty and empty-only
// directories survive the download, and that a path the archive cannot honour is *reported* rather
// than dropped in silence.

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { addSelectedToZip } from "./zip";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ws-zip-test-"));
const WS_DIR = path.join(ROOT, "ws");
const OUTSIDE = path.join(ROOT, "outside");

beforeEach(() => {
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const noSkip = () => {};

/** Directory (`dir: true`) and file entry names present in the generated archive. */
async function zipEntries(paths: string[], rootFolder?: string) {
  const zip = new JSZip();
  await addSelectedToZip(zip, WS_DIR, paths, noSkip, rootFolder);
  await zip.generateAsync({ type: "nodebuffer" });
  const files: string[] = [];
  const dirs: string[] = [];
  for (const [name, entry] of Object.entries(zip.files)) (entry.dir ? dirs : files).push(name);
  return { files, dirs };
}

/** The paths addSelectedToZip refused, in the space the caller named them in. */
async function skipped(paths: string[]) {
  const refused: string[] = [];
  await addSelectedToZip(new JSZip(), WS_DIR, paths, (filePath) => refused.push(filePath));
  return refused;
}

describe("addSelectedToZip", () => {
  it("keeps a selected empty directory in the archive", async () => {
    fs.mkdirSync(path.join(WS_DIR, "empty"));
    const { dirs } = await zipEntries(["empty"]);
    expect(dirs).toContain("empty/");
  });

  it("keeps a directory that contains only an empty subdirectory (the .skills case)", async () => {
    fs.mkdirSync(path.join(WS_DIR, ".skills", "sub"), { recursive: true });
    const { dirs } = await zipEntries([".skills"]);
    expect(dirs).toContain(".skills/");
    expect(dirs).toContain(".skills/sub/");
  });

  it("still includes files and recurses into non-empty directories", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src"));
    fs.writeFileSync(path.join(WS_DIR, "root.txt"), "a");
    fs.writeFileSync(path.join(WS_DIR, "src", "index.ts"), "b");
    const { files } = await zipEntries(["root.txt", "src"]);
    expect(files).toContain("root.txt");
    expect(files).toContain("src/index.ts");
  });

  it("archives a nested selection at its own relative path, not flattened to its name", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "src", "deep", "index.ts"), "b");
    const { files } = await zipEntries(["src/deep/index.ts"]);
    expect(files).toEqual(["src/deep/index.ts"]);
  });

  it("nests every entry under rootFolder so a single file extracts inside a named folder", async () => {
    fs.writeFileSync(path.join(WS_DIR, "root.txt"), "a");
    const { files } = await zipEntries(["root.txt"], "My Workspace");
    expect(files).toContain("My Workspace/root.txt");
    expect(files).not.toContain("root.txt");
  });

  it("nests directory trees under rootFolder", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src"));
    fs.writeFileSync(path.join(WS_DIR, "src", "index.ts"), "b");
    const { files, dirs } = await zipEntries(["src"], "My Workspace");
    expect(files).toContain("My Workspace/src/index.ts");
    expect(dirs).toContain("My Workspace/");
  });

  it("reports a traversal instead of silently shortening the archive", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "s");
    expect(await skipped(["../outside/secret.txt"])).toEqual(["../outside/secret.txt"]);
  });

  it("reports an absolute path rather than resolving it against the process cwd", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "s");
    const absolute = path.join(OUTSIDE, "secret.txt");
    expect(await skipped([absolute])).toEqual([absolute]);
  });

  it("refuses a symlink whose target is outside the tree — a lexical check would have archived it", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "s");
    fs.symlinkSync(OUTSIDE, path.join(WS_DIR, "escape"));
    const { files } = await zipEntries(["escape/secret.txt"]);
    expect(files).toEqual([]);
    expect(await skipped(["escape/secret.txt"])).toEqual(["escape/secret.txt"]);
  });
});
