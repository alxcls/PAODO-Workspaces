/**
 * The download route zips a caller-selected set of workspace-relative paths — the same space the file
 * tree serves, so the browser can hand a selection straight back.
 *
 * Pinned here: empty and empty-only directories survive (JSZip materializes a folder only once
 * something is placed inside it, so a fresh `.skills/` would otherwise vanish); a path the archive
 * cannot honour is reported rather than dropped in silence; and entry names carry the folders that
 * distinguish the selection, but not the empty ancestry above it.
 */

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

  it("drops the ancestry above a single nested file so it is not buried in empty folders", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "src", "deep", "index.ts"), "b");
    const { files } = await zipEntries(["src/deep/index.ts"]);
    expect(files).toEqual(["index.ts"]);
  });

  it("keeps a single selected directory's own name, dropping only what is above it", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "src", "deep", "index.ts"), "b");
    const { files } = await zipEntries(["src/deep"]);
    expect(files).toEqual(["deep/index.ts"]);
  });

  it("keeps the folders that tell two same-named files apart", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src", "api", "a"), { recursive: true });
    fs.mkdirSync(path.join(WS_DIR, "src", "api", "b"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "src", "api", "a", "route.ts"), "a");
    fs.writeFileSync(path.join(WS_DIR, "src", "api", "b", "route.ts"), "b");
    const { files } = await zipEntries(["src/api/a/route.ts", "src/api/b/route.ts"]);
    expect(files.sort()).toEqual(["a/route.ts", "b/route.ts"]);
  });

  it("keeps full paths when the selection spans unrelated branches", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src", "lib"), { recursive: true });
    fs.mkdirSync(path.join(WS_DIR, "docs"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "src", "lib", "util.ts"), "a");
    fs.writeFileSync(path.join(WS_DIR, "docs", "readme.md"), "b");
    const { files } = await zipEntries(["src/lib/util.ts", "docs/readme.md"]);
    expect(files.sort()).toEqual(["docs/readme.md", "src/lib/util.ts"]);
  });

  it("matches shared folders segment-wise, not by string prefix", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src", "app"), { recursive: true });
    fs.mkdirSync(path.join(WS_DIR, "src", "application"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "src", "app", "a.ts"), "a");
    fs.writeFileSync(path.join(WS_DIR, "src", "application", "b.ts"), "b");
    const { files } = await zipEntries(["src/app/a.ts", "src/application/b.ts"]);
    expect(files.sort()).toEqual(["app/a.ts", "application/b.ts"]);
  });

  it("stays well-formed when a directory is selected alongside a file inside it", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "src", "deep", "index.ts"), "b");
    const { files } = await zipEntries(["src/deep", "src/deep/index.ts"]);
    expect(files).toEqual(["deep/index.ts"]);
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
